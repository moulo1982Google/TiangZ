import {
  EventKeyboard,
  Game,
  Input,
  game,
  input,
  KeyCode,
} from "cc";

export interface MoveIntent {
  x: number;
  y: number;
  useItem: boolean;
  switchMap: boolean;
}

export class LocalPlayerController {
  private readonly pressed = new Set<KeyCode>();
  private registered = false;
  private useItemRequested = false;
  private switchMapRequested = false;

  constructor(private readonly onMovementInterrupted: () => void = () => undefined) {
    this.register();
  }

  update(): MoveIntent {
    let dx = 0;
    let dy = 0;
    if (this.pressed.has(KeyCode.KEY_A) || this.pressed.has(KeyCode.ARROW_LEFT)) dx -= 1;
    if (this.pressed.has(KeyCode.KEY_D) || this.pressed.has(KeyCode.ARROW_RIGHT)) dx += 1;
    if (this.pressed.has(KeyCode.KEY_W) || this.pressed.has(KeyCode.ARROW_UP)) dy += 1;
    if (this.pressed.has(KeyCode.KEY_S) || this.pressed.has(KeyCode.ARROW_DOWN)) dy -= 1;
    const useItem = this.useItemRequested;
    const switchMap = this.switchMapRequested;
    this.useItemRequested = false;
    this.switchMapRequested = false;
    return { x: dx, y: dy, useItem, switchMap };
  }

  dispose(): void {
    if (!this.registered) return;
    input.off(Input.EventType.KEY_DOWN, this.onKeyDown, this);
    input.off(Input.EventType.KEY_UP, this.onKeyUp, this);
    game.off(Game.EVENT_HIDE, this.onGameHide, this);
    this.registered = false;
    this.pressed.clear();
  }

  private register(): void {
    if (this.registered) return;
    input.on(Input.EventType.KEY_DOWN, this.onKeyDown, this);
    input.on(Input.EventType.KEY_UP, this.onKeyUp, this);
    game.on(Game.EVENT_HIDE, this.onGameHide, this);
    this.registered = true;
  }

  private onKeyDown(event: EventKeyboard): void {
    const firstPress = !this.pressed.has(event.keyCode);
    this.pressed.add(event.keyCode);
    if (firstPress && event.keyCode === KeyCode.KEY_U) this.useItemRequested = true;
    if (firstPress && event.keyCode === KeyCode.KEY_T) this.switchMapRequested = true;
  }

  private onKeyUp(event: EventKeyboard): void {
    this.pressed.delete(event.keyCode);
  }

  /** Cocos Web/Native隐藏时可能没有KEY_UP，必须立即清键并通知移动层停止。 / Cocos Web/Native may miss KEY_UP while hidden, so clear keys and stop immediately. */
  private onGameHide(): void {
    if (this.pressed.size === 0) return;
    this.pressed.clear();
    this.onMovementInterrupted();
  }
}
