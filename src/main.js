/* eslint-disable no-console */
import React from "react";
import { render } from "react-dom";
import { Provider } from "react-redux";
import { store } from "@/store";
import App from "@/app";
import "@/global.css";

render(
  <Provider store={store}>
    <App />
  </Provider>,
  document.getElementById("app")
);
