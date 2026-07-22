import {
  EventKeyboard,
  Input,
  input,
  KeyCode,
} from "cc";

export interface MoveIntent {
  x: number;
  y: number;
}

export class LocalPlayerController {
  private readonly pressed = new Set<KeyCode>();
  private registered = false;

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
    return { x: dx, y: dy };
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
  }

  private onKeyUp(event: EventKeyboard): void {
    this.pressed.delete(event.keyCode);
  }
}
