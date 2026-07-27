import { Component, component } from "../../../core/public";

@component()
export class NumericComponent extends Component {
  [type: number]: number;

  protected unitHandle = 0;
}
