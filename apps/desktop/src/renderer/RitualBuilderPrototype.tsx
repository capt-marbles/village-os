import {
  RitualBuilder,
  createRitualBuilderState,
  reduceRitualBuilder,
} from "@village/ui";
import { useReducer } from "react";

const prototypeIdentity = {
  draftId: "rtd_01J00000000000000000000000",
  ritualId: "rtl_01J00000000000000000000000",
} as const;

export function RitualBuilderPrototype() {
  const [state, dispatch] = useReducer(
    reduceRitualBuilder,
    undefined,
    createRitualBuilderState,
  );
  return (
    <RitualBuilder
      identity={prototypeIdentity}
      state={state}
      onEvent={dispatch}
    />
  );
}
