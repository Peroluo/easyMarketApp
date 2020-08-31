import * as React from "react";
import { useSelector, useDispatch } from "react-redux";

import { RootState } from "@/store";

export default function Count() {
  const counter = useSelector((state: RootState) => state.count);
  const dispath = useDispatch();
  return (
    <div style={{ display: "flex", flexDirection: "row" }}>
      <div style={{ width: 200 }}>
        <h3>Hooks type count</h3>
        <h1>{counter}</h1>
        <button
          type="button"
          onClick={() => dispath({ type: "count/increment" })}
        >
          +1
        </button>
        <button
          type="button"
          onClick={() => dispath({ type: "count/incrementAsync" })}
        >
          Async +1
        </button>
      </div>
      <p>Using Rematch Models</p>
    </div>
  );
}
