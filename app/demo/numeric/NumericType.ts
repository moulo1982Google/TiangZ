import { NativeNumericField } from "../../generated/model/native/NativeNumericRef";

export const NumericType = NativeNumericField;

export type NumericType =
  typeof NumericType[keyof typeof NumericType];

export const AllNumericTypes = Object.values(NumericType);
