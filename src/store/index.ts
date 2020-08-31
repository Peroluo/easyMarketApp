import { init, RematchRootState, RematchDispatch } from "@rematch/core";
import { count } from "@/store/count";

const models: RootModel = { count };

export const store = init({
  models,
});

export type Store = typeof store;

export type Dispatch = RematchDispatch<RootModel>;

export type RootState = RematchRootState<RootModel>;

export interface RootModel {
  count: typeof count;
}
