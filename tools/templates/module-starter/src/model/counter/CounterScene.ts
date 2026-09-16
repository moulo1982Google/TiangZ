import { EntryScene, entryScene } from "#tiangz/core";

/** 承载入门计数器的运行容器，模块本身不是进程。 / Runtime container for the starter; a module is not a process. */
@entryScene()
export class CounterScene extends EntryScene {}
