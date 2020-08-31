import { Dispatch } from "@/store";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type CountState = number;

export const count = {
  state: 0,
  reducers: {
    increment: (state: CountState) => state + 1,
  },
  effects: (dispatch: Dispatch) => ({
    async incrementAsync() {
      await delay(500);
      dispatch.count.increment();
    },
  }),
};
