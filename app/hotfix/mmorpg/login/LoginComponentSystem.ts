import {
  type C2S_Login,
  type C2S_Register,
  type C2S_CreateCharacter,
  CharacterAccountAlreadyExistsError,
  CreatePasswordCredential,
  type CharacterRecord,
  type CharacterExtensionState,
  GameErrCode,
  GameConfigs,
  GlobalIdSystem,
  LoginComponent,
  type PlayerContentProfileComponent,
  RpcError,
  VerifyPassword,
  EncodeLoginToken,
  SelectStickyGate,
  type S2C_Login,
  type S2C_Register,
  type SceneConfig,
  type CharacterRepository,
  type PlayerRepository,
  NumericType,
  systemFor,
} from "#tiangz/model";

/** 承载登录组件的可热更生命周期与业务流程；稳定字段仍由 Model 持有。 / Hosts hot-reloadable login lifecycle and workflow while Model retains stable fields. */
@systemFor(LoginComponent)
export class LoginComponentSystem extends LoginComponent {
  /** 绑定可用 Gate 列表与当前 Process 身份；空列表会阻止 Scene 启动。 / Binds available Gates and Process identity; an empty list prevents Scene startup. */
  protected override Awake(
    gateScenes: readonly SceneConfig[],
    processId: string,
    characterRepository: CharacterRepository,
    playerContent: PlayerContentProfileComponent,
    playerRepository?: PlayerRepository,
  ): void {
    if (gateScenes.length === 0) throw new Error("LoginComponent needs at least one Gate Scene");
    this.gateScenes = [...gateScenes].sort((left, right) =>
      left.name.localeCompare(right.name)
    );
    this.processId = processId;
    this.characterRepository = characterRepository;
    this.playerContent = playerContent;
    this.playerRepository = playerRepository ?? null;
  }

  /** 完成Demo登录，并用账号稳定选择Gate；全部Login实例对同一拓扑会得到相同结果。 / Completes Demo login and selects a stable Gate by account across Login instances sharing the same topology. */
  async Login(request: C2S_Login): Promise<S2C_Login> {
    const account = normalizeAccount(request.account);
    const password = requirePassword(request.password);

    const catalog = await this.characterRepository.Load(account);
    if (!catalog || catalog.data.credential.hash.length === 0) {
      throw new RpcError(GameErrCode.AccountNotRegistered, "用户未注册");
    }
    if (!VerifyPassword(account, password, catalog.data.credential)) {
      throw new RpcError(GameErrCode.PasswordInvalid, "密码错误");
    }
    const selectedCharacterId = request.characterId ?? catalog.data.characters[0]?.characterId ?? 0n;
    const selected = catalog.data.characters.find((character) => character.characterId === selectedCharacterId);
    if (!selected && (request.characterId !== undefined || catalog.data.characters.length > 0)) {
      throw new RpcError(GameErrCode.CharacterNotFound, `character not found: ${selectedCharacterId}`);
    }
    const loginCount = (this.loginCounts.get(account) ?? 0) + 1;
    this.loginCounts.set(account, loginCount);
    const gate = SelectStickyGate(account, this.gateScenes);
    const characters: import("#tiangz/model").CharacterSummary[] = [];
    for (const character of catalog.data.characters) {
      const summary = toSummary(character);
      const saved = await this.playerRepository?.Load(character.characterId);
      const progression = saved?.data.progression;
      if (progression) {
        if (progression.account !== account || progression.characterId !== character.characterId) {
          throw new Error("character summary progression identity mismatch");
        }
        const levels = progression.numerics.filter(row => row.numericType === NumericType.Level);
        if (levels.length > 1 || levels.some(row => row.value < 1n || row.value > 0xffff_ffffn)) {
          throw new Error("character summary progression level is invalid");
        }
        if (levels.length === 1) summary.level = Number(levels[0].value);
      }
      characters.push(summary);
    }

    return {
      account,
      service: this.processId,
      loginCount,
      token: selected ? EncodeLoginToken({
        processId: this.processId,
        account,
        loginCount,
        characterId: selected.characterId,
        playerConfigId: selected.playerConfigId,
        displayName: selected.name,
      }) : "",
      gateName: gate.name,
      gateIp: gate.outerIp ?? gate.innerIp,
      gatePort: gate.outerPort ?? gate.port,
      characters,
      selectedCharacterId,
    };
  }

  /** 注册凭据；调用方可显式跳过初始角色，默认仍创建同名角色。 / Registers credentials with an opt-in empty catalog; the default still creates a same-name character. */
  async Register(request: C2S_Register): Promise<S2C_Register> {
    const account = normalizeAccount(request.account);
    const password = requirePassword(request.password);
    const character = request.skipInitialCharacter ? undefined : this.newCharacter(
      account,
      account,
      this.resolvePlayerConfigId(request.playerConfigId),
    );
    try {
      const created = await Promise.resolve(this.characterRepository.Register(
        account,
        CreatePasswordCredential(account, password),
        character,
      ));
      return {
        account,
        ...(character ? { character: toSummary(created.data.characters.find((item) => item.characterId === character.characterId) ?? character) } : {}),
      };
    } catch (error) {
      if (error instanceof CharacterAccountAlreadyExistsError) {
        throw new RpcError(GameErrCode.AccountAlreadyExists, "用户已注册");
      }
      throw error;
    }
  }

  /** 创建角色只修改Login目录；角色进入地图仍由Gate/MapHost完成。 / Creates only the Login catalog record; Gate/MapHost still own map entry. */
  async CreateCharacter(request: C2S_CreateCharacter): Promise<import("#tiangz/model").S2C_CreateCharacter> {
    const account = normalizeAccount(request.account);
    const name = request.name.trim();
    if (name.length === 0 || name.length > 32) {
      throw new RpcError(GameErrCode.CharacterNameInvalid, "character name must be 1-32 characters");
    }
    const playerConfigId = this.resolvePlayerConfigId(request.playerConfigId);
    const current = await this.characterRepository.Load(account);
    if (!current || current.data.credential.hash.length === 0) {
      throw new RpcError(GameErrCode.AccountNotRegistered, "用户未注册");
    }
    if (current?.data.characters.some((character) => character.name === name)) {
      throw new RpcError(GameErrCode.CharacterNameInvalid, `character name already exists: ${name}`);
    }
    const created = await Promise.resolve(this.characterRepository.Create(
      account,
      this.newCharacter(account, name, playerConfigId, request.extensions),
    ));
    const character = created.data.characters[created.data.characters.length - 1];
    return {
      character: toSummary(character),
      characters: created.data.characters.map(toSummary),
    };
  }

  private newCharacter(
    account: string,
    name: string,
    playerConfigId = 1,
    extensions: readonly CharacterExtensionState[] = [],
  ): CharacterRecord {
    return {
      characterId: this.NextGlobalId(),
      name,
      playerConfigId,
      level: 1,
      ...(extensions.length > 0
        ? {
            extensions: extensions.map((extension) => ({
              id: extension.id,
              version: extension.version,
              payload: extension.payload.slice(),
            }))
          }
        : {}),
    };
  }

  /** 允许注册和后续创建角色复用同一外置/冷配置校验；0继续表示兼容默认模板1。 / Shares external/cold template validation between registration and later character creation; zero keeps legacy template 1. */
  private resolvePlayerConfigId(requestedPlayerConfigId: number | undefined): number {
    const playerConfigId = requestedPlayerConfigId || 1;
    if (this.playerContent.IsRegistered(playerConfigId)) return playerConfigId;
    try {
      GameConfigs.PlayerConfig.Get(playerConfigId);
      return playerConfigId;
    } catch {
      throw new RpcError(GameErrCode.CharacterNameInvalid, `player config not found: ${playerConfigId}`);
    }
  }

  private NextGlobalId(): bigint {
    return GlobalIdSystem.Instance.Next();
  }
}

function normalizeAccount(value: string | undefined): string {
  const account = value?.trim() ?? "";
  const length = Array.from(account).length;
  if (length === 0) throw new RpcError(GameErrCode.AccountRequired, "账号不能为空");
  if (length > 32 || /\s/u.test(account)) {
    throw new RpcError(GameErrCode.AccountInvalid, "用户名需为1-32个不含空格的字符");
  }
  return account;
}

function requirePassword(value: string | undefined): string {
  if (!value) throw new RpcError(GameErrCode.PasswordRequired, "密码不能为空");
  const length = Array.from(value).length;
  if (length < 6 || length > 64) {
    throw new RpcError(GameErrCode.PasswordInvalid, "密码长度需为6-64个字符");
  }
  return value;
}

function toSummary(character: CharacterRecord): import("#tiangz/model").CharacterSummary {
  return {
    characterId: character.characterId,
    name: character.name,
    playerConfigId: character.playerConfigId,
    level: character.level,
    extensions: (character.extensions ?? []).map((extension) => ({
      id: extension.id,
      version: extension.version,
      payload: extension.payload.slice(),
    })),
  };
}
