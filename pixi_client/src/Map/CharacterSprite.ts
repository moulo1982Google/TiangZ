import { Assets, Container, Rectangle, Sprite, Texture } from "pixi.js";

const WALK_TEXTURE = "./assets/characters/warrior_01/walk.png";
const FRAME_WIDTH = 32;
const FRAME_HEIGHT = 48;
const FRAMES_PER_DIRECTION = 4;
const WALK_FRAMES_PER_SECOND = 8;

const Facing = {
  Down: 0,
  Left: 1,
  Right: 2,
  Up: 3,
} as const;

type Facing = typeof Facing[keyof typeof Facing];
type CharacterFrames = readonly (readonly Texture[])[];

let sharedFrames: Promise<CharacterFrames> | undefined;

/** 播放与 Cocos 相同的四方向角色序列帧。 / Plays the same four-direction character sheet as Cocos. */
export class CharacterSprite {
  private readonly sprite = new Sprite();
  private frames?: CharacterFrames;
  private facing: Facing;
  private moving = false;
  private elapsed = 0;
  private frameIndex = 0;
  private disposed = false;

  constructor(parent: Container, initialFacing: number) {
    this.facing = normalizeFacing(initialFacing);
    this.sprite.anchor.set(0.5);
    this.sprite.y = -6;
    parent.addChild(this.sprite);

    void loadFrames().then((frames) => {
      if (this.disposed) return;
      this.frames = frames;
      this.applyFrame();
    }).catch((error) => console.error("加载 Pixi 玩家序列帧失败", error));
  }

  /** 更新朝向与动画时间；调用方只传权威移动状态，不直接选择帧。 / Advances animation from authoritative facing and movement state. */
  update(deltaSeconds: number, facing: number, moving: boolean): void {
    const nextFacing = normalizeFacing(facing);
    if (nextFacing !== this.facing || moving !== this.moving) {
      this.facing = nextFacing;
      this.moving = moving;
      this.elapsed = 0;
      this.frameIndex = 0;
      this.applyFrame();
    }
    if (!this.moving) return;

    this.elapsed += Math.max(0, Math.min(deltaSeconds, 0.25));
    const nextFrame = Math.floor(this.elapsed * WALK_FRAMES_PER_SECOND) % FRAMES_PER_DIRECTION;
    if (nextFrame === this.frameIndex) return;
    this.frameIndex = nextFrame;
    this.applyFrame();
  }

  dispose(): void {
    this.disposed = true;
  }

  private applyFrame(): void {
    const frames = this.frames?.[this.facing];
    if (!frames) return;
    this.sprite.texture = frames[this.moving ? this.frameIndex : 0];
  }
}

function normalizeFacing(value: number): Facing {
  return value === Facing.Left || value === Facing.Right || value === Facing.Up
    ? value
    : Facing.Down;
}

async function loadFrames(): Promise<CharacterFrames> {
  if (sharedFrames) return sharedFrames;
  sharedFrames = Assets.load<Texture>(WALK_TEXTURE).then((sheet) => {
    const directions: Texture[][] = [];
    for (let row = 0; row < 4; row += 1) {
      const frames: Texture[] = [];
      for (let column = 0; column < FRAMES_PER_DIRECTION; column += 1) {
        frames.push(new Texture({
          source: sheet.source,
          frame: new Rectangle(
            column * FRAME_WIDTH,
            row * FRAME_HEIGHT,
            FRAME_WIDTH,
            FRAME_HEIGHT,
          ),
        }));
      }
      directions.push(frames);
    }
    return directions;
  });
  return sharedFrames;
}
