import { Component, component, lifecycle, transferable } from "../../../core/public";
@component()
@transferable()
@lifecycle({ awake: true })
export class ItemComponent extends Component {}
