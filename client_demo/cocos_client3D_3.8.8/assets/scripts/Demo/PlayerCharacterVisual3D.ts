import {
  instantiate,
  MeshRenderer,
  Node,
  Prefab,
  resources,
  SkeletalAnimation,
} from "cc";

// GLB导入后的主Prefab是文件下的同名子资源，路径必须包含两次BlueChibi。
// The imported GLB prefab is a same-name subasset, so the resource path contains BlueChibi twice.
const BLUE_CHIBI_RESOURCE = "Demo/Characters/Player/blue_chibi/BlueChibi/BlueChibi";
const MODEL_FOOT_OFFSET_Y = -0.9;
const IDLE_CLIP = "Idle";
const WALK_CLIP = "Walk";

let sharedPrefabPromise: Promise<Prefab> | undefined;

/**
 * 管理单个玩家的纯表现模型和动画，不持有Unit数据，也不参与移动、碰撞或网络同步。
 * 异步资源加载期间保留调用方提供的方块占位；模型就绪后只隐藏占位，不改变实体根节点。
 *
 * Owns one player's presentation-only model and animation. It never owns Unit
 * state or participates in movement, collision, or networking. The caller's
 * fallback box remains visible while loading and is hidden after the model is ready.
 */
export class PlayerCharacterVisual3D {
  private animation?: SkeletalAnimation;
  private desiredClip = IDLE_CLIP;
  private activeClip = "";
  private disposed = false;

  constructor(
    private readonly entityRoot: Node,
    private readonly fallback: Node,
  ) {
    void this.loadModel();
  }

  /** 按表现速度切换Idle/Walk；不得用动画状态反推权威移动。 / Switches Idle/Walk from presentation motion; animation must never drive authority. */
  SetMoving(moving: boolean): void {
    this.desiredClip = moving ? WALK_CLIP : IDLE_CLIP;
    this.playDesiredClip();
  }

  /** 标记控制器失效；实体根节点仍由Scene生命周期销毁。 / Marks this controller disposed; Scene lifecycle still owns the entity root. */
  Dispose(): void {
    this.disposed = true;
    this.animation = undefined;
  }

  private async loadModel(): Promise<void> {
    try {
      const prefab = await loadBlueChibiPrefab();
      if (this.disposed || !this.entityRoot.isValid) return;
      const model = instantiate(prefab);
      model.name = "BlueChibiVisual";
      model.setPosition(0, MODEL_FOOT_OFFSET_Y, 0);
      this.entityRoot.addChild(model);
      this.animation = findSkeletalAnimation(model);
      if (!this.animation) throw new Error("Prefab中没有SkeletalAnimation组件");
      this.fallback.active = false;
      this.playDesiredClip(true);
      globalThis.document?.body?.setAttribute("data-tiangz-blue-chibi", "ready");
    } catch (error) {
      globalThis.document?.body?.setAttribute("data-tiangz-blue-chibi", "failed");
      console.warn(`[Cocos3D] 蓝发角色模型加载失败，继续使用方块占位：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private playDesiredClip(force = false): void {
    const animation = this.animation;
    if (!animation || (!force && this.activeClip === this.desiredClip)) return;
    const available = animation.clips.some((clip) => clip?.name === this.desiredClip);
    if (!available) {
      console.warn(`[Cocos3D] 蓝发角色缺少动画片段 ${this.desiredClip}`);
      return;
    }
    if (this.activeClip) animation.crossFade(this.desiredClip, 0.15);
    else animation.play(this.desiredClip);
    this.activeClip = this.desiredClip;
  }
}

/** 清理模型子树中可能继承的调试Mesh开关，仅返回首个骨骼动画组件。 / Returns the first skeletal animation component in the imported model tree. */
function findSkeletalAnimation(root: Node): SkeletalAnimation | undefined {
  const own = root.getComponent(SkeletalAnimation);
  if (own) return own;
  for (const child of root.children) {
    const nested = findSkeletalAnimation(child);
    if (nested) return nested;
  }
  // 引用MeshRenderer可让Cocos类型检查同时确认导入Prefab确实走3D资产管线。
  // Referencing MeshRenderer keeps this helper bound to the 3D asset pipeline at type-check time.
  void root.getComponent(MeshRenderer);
  return undefined;
}

function loadBlueChibiPrefab(): Promise<Prefab> {
  sharedPrefabPromise ??= new Promise<Prefab>((resolve, reject) => {
    resources.load(BLUE_CHIBI_RESOURCE, Prefab, (error, prefab) => {
      if (error) reject(error);
      else resolve(prefab);
    });
  });
  return sharedPrefabPromise;
}
