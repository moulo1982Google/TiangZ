import {
  Color,
  Node,
  Rect,
  resources,
  Sprite,
  SpriteFrame,
  Texture2D,
  UITransform,
} from "cc";
import { normalizeFacing, type Facing } from "./Movement/CellMovement";

const WALK_TEXTURE = "Demo/Characters/Player/warrior_01/walk/texture";
const FRAME_WIDTH = 32;
const FRAME_HEIGHT = 48;
const FRAMES_PER_DIRECTION = 4;
const WALK_FRAMES_PER_SECOND = 8;

type DirectionFrames = readonly SpriteFrame[];
type CharacterFrames = readonly DirectionFrames[];

let sharedFrames: Promise<CharacterFrames> | undefined;

export class CharacterSprite {
  private readonly sprite: Sprite;
  private frames?: CharacterFrames;
  private facing: Facing;
  private moving = false;
  private elapsed = 0;
  private frameIndex = 0;
  private disposed = false;

  constructor(parent: Node, initialFacing: number, tint: Color) {
    this.facing = normalizeFacing(initialFacing);
    const node = new Node("CharacterSprite");
    parent.addChild(node);
    node.setPosition(0, 6, 0);
    node.addComponent(UITransform).setContentSize(FRAME_WIDTH, FRAME_HEIGHT);
    this.sprite = node.addComponent(Sprite);
    this.sprite.sizeMode = Sprite.SizeMode.CUSTOM;
    this.sprite.color = tint;

    void loadFrames().then((frames) => {
      if (this.disposed) return;
      this.frames = frames;
      this.applyFrame();
    }).catch((error) => console.error("加载角色序列帧失败", error));
  }

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
    const nextFrame = Math.floor(this.elapsed * WALK_FRAMES_PER_SECOND) %
      FRAMES_PER_DIRECTION;
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
    this.sprite.spriteFrame = frames[this.moving ? this.frameIndex : 0];
  }
}

function loadFrames(): Promise<CharacterFrames> {
  if (sharedFrames) return sharedFrames;
  sharedFrames = new Promise((resolve, reject) => {
    resources.load(WALK_TEXTURE, Texture2D, (error, texture) => {
      if (error) {
        reject(error);
        return;
      }
      const directions: SpriteFrame[][] = [];
      for (let row = 0; row < 4; row += 1) {
        const frames: SpriteFrame[] = [];
        for (let column = 0; column < FRAMES_PER_DIRECTION; column += 1) {
          const frame = new SpriteFrame();
          frame.texture = texture;
          frame.rect = new Rect(
            column * FRAME_WIDTH,
            row * FRAME_HEIGHT,
            FRAME_WIDTH,
            FRAME_HEIGHT,
          );
          frames.push(frame);
        }
        directions.push(frames);
      }
      resolve(directions);
    });
  });
  return sharedFrames;
}
