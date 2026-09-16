import { Component, component } from "#tiangz/core";

/** 场景拥有的临时计数状态；重启归零，不是玩家存档。 / Scene-owned transient counter, reset on restart and not a player save. */
@component()
export class CounterComponent extends Component {
  protected count = 0;
}

export interface CounterComponent {
  Increment(): number;
}
