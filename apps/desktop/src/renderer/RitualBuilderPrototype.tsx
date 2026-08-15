import {
  RitualBuilder,
  createRitualBuilderState,
  reduceRitualBuilder,
} from "@village/ui";
import { useReducer } from "react";

export function RitualBuilderPrototype() {
  const [state, dispatch] = useReducer(
    reduceRitualBuilder,
    undefined,
    createRitualBuilderState,
  );
  return <RitualBuilder state={state} onEvent={dispatch} />;
}
