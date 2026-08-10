import {
  type C2S_Login,
  type C2S_Register,
  type C2S_CreateCharacter,
  CharacterAccountAlreadyExistsError,
  CreatePasswordCredential,
  type CharacterRecord,
  GameErrCode,
  GameConfigs,
  GlobalIdSystem,
  LoginComponent,
  RpcError,
  VerifyPassword,
  EncodeLoginToken,
  SelectStickyGate,
  type S2C_Login,
  type S2C_Register,
  type SceneConfig,
  type CharacterRepository,
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
  ): void {
    if (gateScenes.length === 0) throw new Error("LoginComponent needs at least one Gate Scene");
    this.gateScenes = [...gateScenes].sort((left, right) =>
      left.name.localeCompare(right.name)
    );
    this.processId = processId;
    this.characterRepository = characterRepository;
  }

  /** 完成Demo登录，并用账号稳定选择Gate；全部Login实例对同一拓扑会得到相同结果。 / Completes Demo login and selects a stable Gate by account across Login instances sharing the same topology. */
  async Login(request: C2S_Login): Promise<S2C_Login> {
    const account = normalizeAccount(request.account);
    const password = requirePassword(request.password);

    const catalog = await this.characterRepository.Load(account);
    if (!catalog || catalog.data.characters.length === 0 || catalog.data.credential.hash.length === 0) {
      throw new RpcError(GameErrCode.AccountNotRegistered, "用户未注册");
    }
    if (!VerifyPassword(account, password, catalog.data.credential)) {
      throw new RpcError(GameErrCode.PasswordInvalid, "密码错误");
    }
    const selectedCharacterId = request.characterId ?? catalog.data.characters[0].characterId;
    const selected = catalog.data.characters.find((character) => character.characterId === selectedCharacterId);
    if (!selected) {
      throw new RpcError(GameErrCode.CharacterNotFound, `character not found: ${selectedCharacterId}`);
    }
    const loginCount = (this.loginCounts.get(account) ?? 0) + 1;
    this.loginCounts.set(account, loginCount);
    const gate = SelectStickyGate(account, this.gateScenes);

    return {
      account,
      service: this.processId,
      loginCount,
      token: EncodeLoginToken({
        processId: this.processId,
        account,
        loginCount,
        characterId: selected.characterId,
      }),
      gateName: gate.name,
      gateIp: gate.outerIp ?? gate.innerIp,
      gatePort: gate.outerPort ?? gate.port,
      characters: catalog.data.characters.map(toSummary),
      selectedCharacterId,
    };
  }

  /** 注册账号并创建同名初始角色；密码只以摘要形式进入账号目录。 / Registers an account and creates its same-name starter character; only a digest is stored. */
  async Register(request: C2S_Register): Promise<S2C_Register> {
    const account = normalizeAccount(request.account);
    const password = requirePassword(request.password);
    const character = this.newCharacter(account, account);
    try {
      const created = await Promise.resolve(this.characterRepository.Register(
        account,
        CreatePasswordCredential(account, password),
        character,
      ));
      return {
        account,
        character: toSummary(created.data.characters.find((item) => item.characterId === character.characterId) ?? character),
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
    const playerConfigId = request.playerConfigId || 1;
    try {
      GameConfigs.PlayerConfig.Get(playerConfigId);
    } catch {
      throw new RpcError(GameErrCode.CharacterNameInvalid, `player config not found: ${playerConfigId}`);
    }
    const current = await this.characterRepository.Load(account);
    if (!current || current.data.credential.hash.length === 0) {
      throw new RpcError(GameErrCode.AccountNotRegistered, "用户未注册");
    }
    if (current?.data.characters.some((character) => character.name === name)) {
      throw new RpcError(GameErrCode.CharacterNameInvalid, `character name already exists: ${name}`);
    }
    const created = await Promise.resolve(this.characterRepository.Create(
      account,
      this.newCharacter(account, name, playerConfigId),
    ));
    const character = created.data.characters[created.data.characters.length - 1];
    return {
      character: toSummary(character),
      characters: created.data.characters.map(toSummary),
    };
  }

  private newCharacter(account: string, name: string, playerConfigId = 1): CharacterRecord {
    return {
      characterId: this.NextGlobalId(),
      name,
      playerConfigId,
      level: 1,
    };
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
  };
}
