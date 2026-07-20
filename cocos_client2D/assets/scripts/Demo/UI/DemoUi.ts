import {
  Button,
  Color,
  Graphics,
  Label,
  Node,
  UITransform,
  view,
} from "cc";

export class DemoUi {
  constructor(readonly root: Node) {}

  clear(): void {
    this.root.removeAllChildren();
  }

  createBackground(color: Color): Node {
    const background = this.createBox(
      "Background",
      0,
      0,
      view.getVisibleSize().width,
      view.getVisibleSize().height,
      color,
    );
    background.setSiblingIndex(0);
    return background;
  }

  createButton(
    text: string,
    x: number,
    y: number,
    width: number,
    height: number,
  ): Node {
    const node = this.createBox(
      text,
      x,
      y,
      width,
      height,
      new Color(72, 117, 214, 255),
    );
    const button = node.addComponent(Button);
    button.transition = Button.Transition.COLOR;
    button.normalColor = new Color(72, 117, 214, 255);
    button.hoverColor = new Color(88, 136, 235, 255);
    button.pressedColor = new Color(55, 94, 184, 255);
    button.disabledColor = new Color(70, 76, 92, 255);
    this.createLabel(text, 0, 0, 20, new Color(255, 255, 255, 255), node);
    return node;
  }

  createLabel(
    text: string,
    x: number,
    y: number,
    size: number,
    color: Color,
    parent: Node = this.root,
  ): Label {
    const node = new Node(`Label:${text}`);
    parent.addChild(node);
    node.setPosition(x, y);
    const transform = node.addComponent(UITransform);
    transform.setContentSize(720, size + 12);
    const label = node.addComponent(Label);
    label.string = text;
    label.fontSize = size;
    label.lineHeight = size + 6;
    label.color = color;
    label.horizontalAlign = Label.HorizontalAlign.CENTER;
    label.verticalAlign = Label.VerticalAlign.CENTER;
    return label;
  }

  createBox(
    name: string,
    x: number,
    y: number,
    width: number,
    height: number,
    color: Color,
    parent: Node = this.root,
  ): Node {
    const node = new Node(name);
    parent.addChild(node);
    node.setPosition(x, y);
    const transform = node.addComponent(UITransform);
    transform.setContentSize(width, height);
    const graphics = node.addComponent(Graphics);
    graphics.fillColor = color;
    graphics.fillRect(-width / 2, -height / 2, width, height);
    return node;
  }
}
