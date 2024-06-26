import type { AnyAction, Dispatch, Store } from '@reduxjs/toolkit'
import { bindActionCreators } from '@reduxjs/toolkit'
import type { ReactElement } from 'react'
import React, { Component } from 'react'
import { createRoot } from 'react-dom/client'
import type { ConnectedProps, DispatchProp, MapStateToProps } from 'react-redux'
import { Provider, connect } from 'react-redux'
import type { CounterState } from './counterApp'
import { increment } from './counterApp'

const objectAssign = Object.assign

class Counter extends Component<any, any> {
  render() {
    return <button onClick={this.props.onIncrement}>{this.props.value}</button>
  }
}

function mapStateToProps(state: CounterState) {
  return {
    value: state.counter,
  }
}

// Which action creators does it want to receive by props?
function mapDispatchToProps(dispatch: Dispatch<AnyAction>) {
  return {
    onIncrement: () => dispatch(increment()),
  }
}

connect(mapStateToProps, mapDispatchToProps)(Counter)

class CounterContainer extends Component<any, any> {}

const ConnectedCounterContainer = connect(mapStateToProps)(CounterContainer)

// Ensure connect's first two arguments can be replaced by wrapper functions
interface ICounterStateProps {
  value: number
}
interface ICounterDispatchProps {
  onIncrement: () => void
}
connect<ICounterStateProps, ICounterDispatchProps, {}, CounterState>(
  () => mapStateToProps,
  () => mapDispatchToProps,
)(Counter)
// only first argument
connect<ICounterStateProps, {}, {}, CounterState>(() => mapStateToProps)(
  Counter,
)
// wrap only one argument
connect<ICounterStateProps, ICounterDispatchProps, {}, CounterState>(
  mapStateToProps,
  () => mapDispatchToProps,
)(Counter)
// with extra arguments
connect<ICounterStateProps, ICounterDispatchProps, {}, {}, CounterState>(
  () => mapStateToProps,
  () => mapDispatchToProps,
  (s: ICounterStateProps, d: ICounterDispatchProps) => objectAssign({}, s, d),
  { forwardRef: true },
)(Counter)

class App extends Component<any, any> {
  render(): React.ReactNode {
    // ...
    return null
  }
}

const container = document.getElementById('root')

if (container) {
  const root = createRoot(container)

  root.render(
    <Provider store={store}>
      <App />
    </Provider>,
  )
} else {
  throw new Error(
    "Root element with ID 'root' was not found in the document. Ensure there is a corresponding HTML element with the ID 'root' in your HTML file.",
  )
}

declare let store: Store<TodoState>

class MyRootComponent extends Component<any, any> {}

class TodoApp extends Component<any, any> {}

interface TodoState {
  todos: string[] | string
}

interface TodoProps {
  userId: number
}

interface DispatchProps {
  addTodo(userId: number, text: string): void
  // action: Function
}

const addTodo = (userId: number, text: string) => ({
  type: 'todos/todoAdded',
  payload: { userId, text },
})

const actionCreators = { addTodo }

type AddTodoAction = ReturnType<typeof addTodo>

declare let todoActionCreators: { [type: string]: (...args: any[]) => any }

declare let counterActionCreators: { [type: string]: (...args: any[]) => any }

if (container) {
  const root = createRoot(container)

  root.render(
    <Provider store={store}>
      <MyRootComponent />
    </Provider>,
  )
} else {
  throw new Error(
    "Root element with ID 'root' was not found in the document. Ensure there is a corresponding HTML element with the ID 'root' in your HTML file.",
  )
}

// Inject just dispatch and don't listen to store

connect()(TodoApp)

// Inject dispatch and every field in the global state

connect((state: TodoState) => state)(TodoApp)

// Inject dispatch and todos

function mapStateToProps2(state: TodoState) {
  return { todos: state.todos }
}

export default connect(mapStateToProps2)(TodoApp)

// Inject todos and all action creators (addTodo, completeTodo, ...)

connect(mapStateToProps2, actionCreators)(TodoApp)

// Inject todos and all action creators (addTodo, completeTodo, ...) as actions

function mapDispatchToProps2(dispatch: Dispatch<AnyAction>) {
  return { actions: bindActionCreators(actionCreators, dispatch) }
}

connect(mapStateToProps2, mapDispatchToProps2)(TodoApp)

// Inject todos and a specific action creator (addTodo)

function mapDispatchToProps3(dispatch: Dispatch<AnyAction>) {
  return bindActionCreators({ addTodo }, dispatch)
}

connect(mapStateToProps2, mapDispatchToProps3)(TodoApp)

// Inject todos, todoActionCreators as todoActions, and counterActionCreators as counterActions

function mapDispatchToProps4(dispatch: Dispatch<AnyAction>) {
  return {
    todoActions: bindActionCreators(todoActionCreators, dispatch),
    counterActions: bindActionCreators(counterActionCreators, dispatch),
  }
}

connect(mapStateToProps2, mapDispatchToProps4)(TodoApp)

// Inject todos, and todoActionCreators and counterActionCreators together as actions

//function mapStateToProps(state) {
//    return { todos: state.todos };
//}

function mapDispatchToProps5(dispatch: Dispatch<AnyAction>) {
  return {
    actions: bindActionCreators(
      objectAssign({}, todoActionCreators, counterActionCreators),
      dispatch,
    ),
  }
}

connect(mapStateToProps2, mapDispatchToProps5)(TodoApp)

// Inject todos, and all todoActionCreators and counterActionCreators directly as props

function mapDispatchToProps6(dispatch: Dispatch<AnyAction>) {
  return bindActionCreators(
    objectAssign({}, todoActionCreators, counterActionCreators),
    dispatch,
  )
}

connect(mapStateToProps2, mapDispatchToProps6)(TodoApp)

// Inject todos of a specific user depending on props

function mapStateToProps3(state: TodoState, ownProps: TodoProps): TodoState {
  return { todos: state.todos[ownProps.userId] }
}

connect(mapStateToProps3)(TodoApp)

// Inject todos of a specific user depending on props, and inject props.userId into the action

function mergeProps(
  stateProps: TodoState,
  dispatchProps: DispatchProps,
  ownProps: TodoProps,
): { addTodo: (userId: string) => void } & TodoState {
  return objectAssign({}, ownProps, {
    todos: stateProps.todos[ownProps.userId],
    addTodo: (text: string) => dispatchProps.addTodo(ownProps.userId, text),
  })
}

connect(mapStateToProps2, actionCreators, mergeProps)(TodoApp)

interface TestProp {
  property1: number
  someOtherProperty?: string
}
interface TestState {
  isLoaded: boolean
  state1: number
}
class TestComponent extends Component<TestProp, TestState> {}
const WrappedTestComponent = connect()(TestComponent)

// return value of the connect()(TestComponent) is of the type TestComponent
let ATestComponent: React.ComponentType<TestProp> = TestComponent
ATestComponent = WrappedTestComponent

let anElement: ReactElement<TestProp>
;<TestComponent property1={42} />
;<WrappedTestComponent property1={42} />
;<ATestComponent property1={42} />

// @ts-expect-error
;<ATestComponent property1={42} dummyField={123} />

class NonComponent {}

// this doesn't compile
expectTypeOf(connect()).parameter(0).not.toMatchTypeOf(NonComponent)

// stateless functions
interface HelloMessageProps {
  name: string
}
function HelloMessage(props: HelloMessageProps) {
  return <div>Hello {props.name}</div>
}
const ConnectedHelloMessage = connect()(HelloMessage)

if (container) {
  const root = createRoot(container)

  root.render(<HelloMessage name="Sebastian" />)

  root.render(<ConnectedHelloMessage name="Sebastian" />)
} else {
  throw new Error(
    "Root element with ID 'root' was not found in the document. Ensure there is a corresponding HTML element with the ID 'root' in your HTML file.",
  )
}

describe('type tests', () => {
  test('stateless functions that uses mapStateToProps and mapDispatchToProps', () => {
    interface GreetingProps {
      name: string
      onClick: () => void
    }

    function Greeting(props: GreetingProps) {
      return <div>Hello {props.name}</div>
    }

    const mapStateToProps = (state: any, ownProps: GreetingProps) => {
      return {
        name: `Connected! ${ownProps.name}`,
      }
    }

    const mapDispatchToProps = (
      dispatch: Dispatch<AnyAction>,
      ownProps: GreetingProps,
    ) => {
      return {
        onClick: () => {
          dispatch({ type: 'GREETING', name: ownProps.name })
        },
      }
    }

    const ConnectedGreeting = connect(
      mapStateToProps,
      mapDispatchToProps,
    )(Greeting)
  })

  test('OwnProps inference', () => {
    // https://github.com/DefinitelyTyped/DefinitelyTyped/issues/8787

    interface OwnProps {
      own: string
    }

    interface StateProps {
      state: string
    }

    class OwnPropsComponent extends React.Component<OwnProps & StateProps, {}> {
      render() {
        return <div />
      }
    }

    function mapStateToPropsWithoutOwnProps(state: any): StateProps {
      return { state: 'string' }
    }

    function mapStateToPropsWithOwnProps(
      state: any,
      ownProps: OwnProps,
    ): StateProps {
      return { state: 'string' }
    }

    const ConnectedWithoutOwnProps = connect(mapStateToPropsWithoutOwnProps)(
      OwnPropsComponent,
    )
    const ConnectedWithOwnProps = connect(mapStateToPropsWithOwnProps)(
      OwnPropsComponent,
    )
    const ConnectedWithTypeHint = connect<StateProps, {}, OwnProps>(
      mapStateToPropsWithoutOwnProps,
    )(OwnPropsComponent)

    expectTypeOf(React.createElement).parameters.not.toMatchTypeOf([
      ConnectedWithoutOwnProps,
      { anything: 'goes!' },
    ] as const)

    // This compiles, as expected.
    /**
     * NOTE: We can't do
     * ```
     * expectTypeOf(React.createElement).toBeCallableWith(ConnectedWithOwnProps, {
     *   own: 'string',
     * })
     * ```
     * because `.toBeCallableWith()` does not work well with function overloads.
     */
    React.createElement(ConnectedWithOwnProps, { own: 'string' })

    // This should not compile, which is good.
    // @ts-expect-error
    React.createElement(ConnectedWithOwnProps, { missingOwn: true })

    // This compiles, as expected.
    React.createElement(ConnectedWithTypeHint, { own: 'string' })

    // This should not compile, which is good.
    // @ts-expect-error
    React.createElement(ConnectedWithTypeHint, { missingOwn: true })

    interface AllProps {
      own: string
      state: string
    }

    class AllPropsComponent extends React.Component<AllProps & DispatchProp> {
      render() {
        return <div />
      }
    }

    type PickedOwnProps = Pick<AllProps, 'own'>

    type PickedStateProps = Pick<AllProps, 'state'>

    const mapStateToPropsForPicked: MapStateToProps<
      PickedStateProps,
      PickedOwnProps,
      {}
    > = (state: any): PickedStateProps => {
      return { state: 'string' }
    }

    const ConnectedWithPickedOwnProps = connect(mapStateToPropsForPicked)(
      AllPropsComponent,
    )
    ;<ConnectedWithPickedOwnProps own="blah" />
  })

  test('connected props', () => {
    interface RootState {
      isOn: boolean
    }

    const mapState1 = (state: RootState) => ({
      isOn: state.isOn,
    })

    const mapDispatch1 = {
      toggleOn: () => ({ type: 'TOGGLE_IS_ON' }),
    }

    const connector1 = connect(mapState1, mapDispatch1)

    // The inferred type will look like:
    // {isOn: boolean, toggleOn: () => void}
    type PropsFromRedux1 = ConnectedProps<typeof connector1>

    assertType<{
      isOn: boolean
      toggleOn: () => void
    }>({} as PropsFromRedux1)

    const exampleThunk = (id: number) => async (dispatch: Dispatch) => {
      return 'test'
    }

    const mapDispatch2 = { exampleThunk }

    // Connect should "resolve thunks", so that instead of typing the return value of the
    // prop as the thunk function, it dives down and uses the return value of the thunk function itself
    const connector2 = connect(null, mapDispatch2)

    type PropsFromRedux2 = ConnectedProps<typeof connector2>

    expectTypeOf<{
      exampleThunk: (id: number) => Promise<string>
    }>().toEqualTypeOf<PropsFromRedux2>()
  })
})
