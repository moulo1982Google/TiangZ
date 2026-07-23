import {
  _decorator,
  Button,
  Canvas,
  Color,
  Component,
  director,
  Label,
  Node,
  ResolutionPolicy,
  Scene,
  UITransform,
  view,
} from "cc";
import { NATIVE, PREVIEW } from "cc/env";
import { LoginFlow } from "../Generated/SDK/Demo/LoginFlow";
import type { ClientTransportKind } from "../Generated/SDK/Core/Net/ClientTransport";
import "../Generated/SDK/Core/Net/BrowserWebSocketTransport";
import "../Generated/SDK/Core/Net/NativeTransport";
import { MapController } from "./Map/MapController";
import { MapView } from "./Map/MapView";
import { DemoUi } from "./UI/DemoUi";

const { ccclass, property } = _decorator;

@ccclass("GameBootstrap")
export class GameBootstrap extends Component {
  @property
  transport: ClientTransportKind = NATIVE ? "kcp" : "websocket";

  @property
  loginMgrHost = "127.0.0.1";

  @property
  loginMgrPort = 7000;

  private started = false;
  private ui?: DemoUi;
  private loginFlow?: LoginFlow;
  private playerController?: MapController;
  private statusLabel?: Label;
  private loginButton?: Button;
  private account = "";

  onLoad(): void {
    this.ensureStarted();
  }

  onEnable(): void {
    this.ensureStarted();
  }

  update(deltaTime: number): void {
    this.loginFlow?.update();
    this.playerController?.update(deltaTime);
  }

  onDestroy(): void {
    this.playerController?.dispose();
    this.playerController = undefined;
    this.loginFlow?.close();
    this.loginFlow = undefined;
  }

  ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    view.setDesignResolutionSize(960, 640, ResolutionPolicy.SHOW_ALL);
    if (!NATIVE) view.resizeWithBrowserSize(true);
    if (!this.node.getComponent(Canvas)) this.node.addComponent(Canvas);
    this.hidePreviewSplash();
    this.ui = new DemoUi(this.ensureUiRoot());
    this.showLoginView();
  }

  private showLoginView(): void {
    const ui = this.requireUi();
    ui.clear();
    ui.createBackground(new Color(24, 28, 36, 255));
    ui.createLabel(
      "ets_runtime 2D Demo",
      0,
      150,
      32,
      new Color(245, 248, 255, 255),
    );

    this.account = `guest_${Math.floor(Math.random() * 100000)}`;
    ui.createLabel(
      `账号：${this.account}`,
      0,
      88,
      20,
      new Color(190, 200, 218, 255),
    );
    this.statusLabel = ui.createLabel(
      "点击按钮连接 LoginMgr 并进入地图",
      0,
      34,
      18,
      new Color(125, 220, 170, 255),
    );

    const buttonNode = ui.createButton("进入游戏", 0, -48, 220, 54);
    this.loginButton = buttonNode.getComponent(Button)!;
    buttonNode.on(Button.EventType.CLICK, () => void this.loginAndEnter(), this);
  }

  private async loginAndEnter(): Promise<void> {
    this.setLoginEnabled(false);
    this.loginFlow?.close();
    this.loginFlow = new LoginFlow({
      transport: this.transport,
      host: this.loginMgrHost,
      port: this.loginMgrPort,
    });
    try {
      const result = await this.loginFlow.enterGame(
        this.account,
        1,
        (message) => this.setStatus(message),
      );
      this.playerController?.dispose();
      this.playerController = new MapView(this.requireUi()).show(
        result.login,
        result.enterMap,
        result.mapReady,
        result.gateSocket,
      );
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : String(error), true);
      this.setLoginEnabled(true);
    }
  }

  private setStatus(text: string, isError = false): void {
    if (!this.statusLabel?.isValid) return;
    this.statusLabel.string = text;
    this.statusLabel.color = isError
      ? new Color(255, 120, 120, 255)
      : new Color(125, 220, 170, 255);
  }

  private setLoginEnabled(enabled: boolean): void {
    if (this.loginButton?.isValid) this.loginButton.interactable = enabled;
  }

  private requireUi(): DemoUi {
    if (!this.ui) throw new Error("Demo UI 尚未初始化");
    return this.ui;
  }

  private ensureUiRoot(): Node {
    const existing = this.node.getChildByName("EtsUiRoot");
    const root = existing ?? new Node("EtsUiRoot");
    if (!existing) this.node.addChild(root);
    const transform = root.getComponent(UITransform) ?? root.addComponent(UITransform);
    transform.setContentSize(960, 640);
    root.setPosition(0, 0);
    return root;
  }

  private hidePreviewSplash(): void {
    const splash = globalThis.document?.getElementById?.("splash") as
      | { style?: { display: string } }
      | null
      | undefined;
    if (splash?.style) splash.style.display = "none";
  }
}

installAutoBootstrap();

function installAutoBootstrap(): void {
  const global = globalThis as typeof globalThis & {
    __etsGameBootstrapAutoMounted?: boolean;
  };
  const href = globalThis.location?.href ?? "";
  const browserPreview = href.includes("localhost") || href.includes("127.0.0.1");
  if ((!PREVIEW && !browserPreview && !NATIVE) || global.__etsGameBootstrapAutoMounted) return;
  global.__etsGameBootstrapAutoMounted = true;

  let attempts = 0;
  const tryMount = () => {
    let scene = director.getScene();
    if (!scene && attempts > 20) {
      scene = new Scene("main");
      const runtimeDirector = director as typeof director & {
        runSceneImmediate?: (scene: Scene) => void;
        runScene?: (scene: Scene) => void;
      };
      if (runtimeDirector.runSceneImmediate) {
        runtimeDirector.runSceneImmediate(scene);
      } else {
        runtimeDirector.runScene?.(scene);
      }
    }
    if (!scene) {
      attempts += 1;
      setTimeout(tryMount, 50);
      return;
    }

    const existing = scene.getComponentsInChildren(GameBootstrap);
    if (existing.length > 0) {
      existing[0].ensureStarted();
      return;
    }
    const node = new Node("GameBootstrap");
    scene.addChild(node);
    node.addComponent(GameBootstrap);
  };
  setTimeout(tryMount, 0);
}
