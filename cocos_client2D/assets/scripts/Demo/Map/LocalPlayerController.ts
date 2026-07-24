import {
  EventKeyboard,
  Input,
  input,
  KeyCode,
} from "cc";

export interface MoveIntent {
  x: number;
  y: number;
  useItem: boolean;
}

export class LocalPlayerController {
  private readonly pressed = new Set<KeyCode>();
  private registered = false;
  private useItemRequested = false;

  constructor() {
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
    this.useItemRequested = false;
    return { x: dx, y: dy, useItem };
  }

  dispose(): void {
    if (!this.registered) return;
    input.off(Input.EventType.KEY_DOWN, this.onKeyDown, this);
    input.off(Input.EventType.KEY_UP, this.onKeyUp, this);
    this.registered = false;
    this.pressed.clear();
  }

  private register(): void {
    if (this.registered) return;
    input.on(Input.EventType.KEY_DOWN, this.onKeyDown, this);
    input.on(Input.EventType.KEY_UP, this.onKeyUp, this);
    this.registered = true;
  }

  private onKeyDown(event: EventKeyboard): void {
    this.pressed.add(event.keyCode);
    if (event.keyCode === KeyCode.KEY_U) this.useItemRequested = true;
  }

  private onKeyUp(event: EventKeyboard): void {
    this.pressed.delete(event.keyCode);
  }
}
