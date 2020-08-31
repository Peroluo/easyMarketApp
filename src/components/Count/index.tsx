import * as React from "react";
import { connect } from "react-redux";

import { RootState, Dispatch } from "@/store";

const mapState = (state: RootState) => ({
  dolphins: state.count,
});

const mapDispatch = (dispatch: Dispatch) => ({
  increment: dispatch.count.increment,
  incrementAsync: dispatch.count.incrementAsync,
});

type Props = ReturnType<typeof mapState> & ReturnType<typeof mapDispatch>;

class Count extends React.PureComponent<Props> {
  render() {
    return (
      <div style={{ display: "flex", flexDirection: "row" }}>
        <div style={{ width: 200 }}>
          <h3>Class type Count</h3>
          <h1>{this.props.dolphins}</h1>
          <button type="button" onClick={this.props.increment}>
            +1
          </button>
          <button type="button" onClick={this.props.incrementAsync}>
            Async +1
          </button>
        </div>
        <p>Using Rematch Models</p>
        <p>Using Rematch Models</p>
      </div>
    );
  }
}

export default connect(mapState, mapDispatch)(Count);
