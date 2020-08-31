import React from "react";
import "./global.less";
import { useHistory } from "react-router-dom";

function App() {
  const history = useHistory();
  return (
    <div
      className="App"
      onClick={() => {
        history.push("/count");
      }}
    >
      <header className="App-header">
        <img src="/static/logo.svg" className="App-logo" alt="logo" />
        <p className="App-link">
          <a
            className="App-link"
            href="https://reactjs.org"
            target="_blank"
            rel="noopener noreferrer"
          >
            React
          </a>
          、Redux、Rematch、React-Router、TypeScript、JavaScript、Postcss、
          Less、Webpack
        </p>
        <br />
        <p>
          Edit <code>src/page/index.js</code> and save to reload.
        </p>
        <br />
      </header>
    </div>
  );
}

export default App;
