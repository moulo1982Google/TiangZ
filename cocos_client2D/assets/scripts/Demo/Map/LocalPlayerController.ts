import {
  EventKeyboard,
  Input,
  input,
  KeyCode,
} from "cc";
import { RpcSocket } from "../../Core/Net/RpcSocket";
import { MapMessages } from "../../Generated/Model/demo/protocol/messageDescriptors";

export class LocalPlayerController {
  private readonly pressed = new Set<KeyCode>();
  private registered = false;
  private sequence = 0;
  private sendAccumulator = 0;

  constructor(
    private readonly socket: RpcSocket,
  ) {
    this.register();
  }

  update(deltaTime: number): void {
    let dx = 0;
    let dy = 0;
    if (this.pressed.has(KeyCode.KEY_A) || this.pressed.has(KeyCode.ARROW_LEFT)) dx -= 1;
    if (this.pressed.has(KeyCode.KEY_D) || this.pressed.has(KeyCode.ARROW_RIGHT)) dx += 1;
    if (this.pressed.has(KeyCode.KEY_W) || this.pressed.has(KeyCode.ARROW_UP)) dy += 1;
    if (this.pressed.has(KeyCode.KEY_S) || this.pressed.has(KeyCode.ARROW_DOWN)) dy -= 1;
    if (dx === 0 && dy === 0) {
      this.sendAccumulator = 0;
      return;
    }

    this.sendAccumulator += deltaTime;
    if (this.sendAccumulator < 0.05) return;
    this.sendAccumulator %= 0.05;
    this.sequence += 1;
    void this.socket.send(MapMessages.Move, {
      inputX: dx,
      inputY: dy,
      sequence: this.sequence,
    }).catch((error) => console.error("发送移动输入失败", error));
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
