import { Component, type ReactNode } from "react";
import { Button } from "./Button.tsx";

interface Props {
  /** Change this to reset the boundary (e.g. the current location). */
  resetKey?: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Per-page error boundary: a render crash shows a recoverable panel instead of a blank app. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (this.state.error) {
      return (
        <div className="boundary">
          <h3>something broke rendering this page</h3>
          <p>{this.state.error.message}</p>
          <Button onClick={() => this.setState({ error: null })}>try again</Button>
        </div>
      );
    }
    return this.props.children;
  }
}
