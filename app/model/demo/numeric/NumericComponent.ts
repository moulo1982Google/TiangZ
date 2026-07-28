import { Component, component, lifecycle, transferable } from "../../../core/public";

@component()
@transferable()
@lifecycle({ awake: true, destroy: true })
export class NumericComponent extends Component {
  [type: number]: number;

  protected unitHandle = 0;
}
