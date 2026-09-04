import {
  AllNumericTypes as AllBaseNumericTypes,
  IsDerivedNumericType,
  NumericType as BaseNumericType,
} from "../../domains/numeric/NumericType";
import {
  MovementNumericType,
  NUMERIC_MOVE_SPEED_SCALE,
  MoveSpeedMetersPerSecondToNumeric,
} from "./MovementNumeric";
import { AttributeNumericType } from "./AttributeNumeric";

/**
 * MMORPG把移动速度作为领域扩展拼接进通用Numeric；通用层本身不认识空间单位。
 * MMORPG composes MoveSpeed as a domain extension; the reusable Numeric layer
 * itself does not know spatial units.
 */
export const NumericType = {
  ...BaseNumericType,
  ...AttributeNumericType,
  ...MovementNumericType,
} as const;
export type NumericType = typeof NumericType[keyof typeof NumericType];
export const AllNumericTypes: readonly NumericType[] = [
  ...AllBaseNumericTypes,
  ...Object.values(AttributeNumericType),
  ...Object.values(MovementNumericType),
];
export {
  AttributeNumericType,
  IsDerivedNumericType,
  NUMERIC_MOVE_SPEED_SCALE,
  MoveSpeedMetersPerSecondToNumeric,
};
export type NumericTypeValue = NumericType;
