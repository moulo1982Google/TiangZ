/**
 * 怪物基础行为树的执行结果；当前所有动作都在一个逻辑Tick内完成。
 * The result of the basic monster behavior tree; every current action completes within one logic tick.
 */
enum BehaviorStatus {
  Success,
  Failure,
}

export type MonsterBehaviorAction = "idle" | "hold" | "chase" | "attack";

export interface MonsterBehaviorContext {
  readonly mayAggro: boolean;
  readonly hasTarget: boolean;
  readonly inAttackRange: boolean;
  readonly canAttack: boolean;
}

interface BehaviorNode {
  tick(context: BehaviorTickContext): BehaviorStatus;
}

interface BehaviorTickContext extends MonsterBehaviorContext {
  action: MonsterBehaviorAction;
}

class ConditionNode implements BehaviorNode {
  constructor(private readonly predicate: (context: BehaviorTickContext) => boolean) {}

  tick(context: BehaviorTickContext): BehaviorStatus {
    return this.predicate(context) ? BehaviorStatus.Success : BehaviorStatus.Failure;
  }
}

class ActionNode implements BehaviorNode {
  constructor(private readonly action: MonsterBehaviorAction) {}

  tick(context: BehaviorTickContext): BehaviorStatus {
    context.action = this.action;
    return BehaviorStatus.Success;
  }
}

/** 顺序节点：所有子节点成功才成功；Sequence succeeds only when every child succeeds. */
class SequenceNode implements BehaviorNode {
  constructor(private readonly children: readonly BehaviorNode[]) {}

  tick(context: BehaviorTickContext): BehaviorStatus {
    for (const child of this.children) {
      if (child.tick(context) === BehaviorStatus.Failure) return BehaviorStatus.Failure;
    }
    return BehaviorStatus.Success;
  }
}

/** 选择节点：第一个成功分支生效；Selector chooses the first successful branch. */
class SelectorNode implements BehaviorNode {
  constructor(private readonly children: readonly BehaviorNode[]) {}

  tick(context: BehaviorTickContext): BehaviorStatus {
    for (const child of this.children) {
      if (child.tick(context) === BehaviorStatus.Success) return BehaviorStatus.Success;
    }
    return BehaviorStatus.Failure;
  }
}

/**
 * 怪物模块专用的小行为树：主动怪有目标时攻击或追击，否则待机。
 * This small tree is private to the monster module: an aggro monster attacks or chases a target,
 * and otherwise stays idle. It is intentionally not a general AI framework.
 */
export class MonsterBehaviorTree {
  private readonly root: BehaviorNode = new SelectorNode([
    new SequenceNode([
      new ConditionNode((context) => context.mayAggro),
      new ConditionNode((context) => context.hasTarget),
      new SelectorNode([
        new SequenceNode([
          new ConditionNode((context) => context.inAttackRange),
          new SelectorNode([
            new SequenceNode([
              new ConditionNode((context) => context.canAttack),
              new ActionNode("attack"),
            ]),
            new ActionNode("hold"),
          ]),
        ]),
        new ActionNode("chase"),
      ]),
    ]),
    new ActionNode("idle"),
  ]);

  /** 根据当前快照选择本Tick动作；不保存目标、冷却或Unit引用。 / Chooses this tick's action without retaining targets, cooldowns, or Units. */
  Evaluate(context: MonsterBehaviorContext): MonsterBehaviorAction {
    const tickContext: BehaviorTickContext = { ...context, action: "idle" };
    this.root.tick(tickContext);
    return tickContext.action;
  }
}
