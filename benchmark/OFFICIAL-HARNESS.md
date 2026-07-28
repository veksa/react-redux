# Results on the official `reduxjs/react-redux-benchmarks`

The standalone scripts in this folder measure the notification pass in isolation.
This file records runs on Redux's **own** benchmark harness, in a real headless
Chromium, comparing published `react-redux@9.2.0` against this branch.

Environment: Ryzen 7 7840HS, headless Chromium (Playwright), React 19, medians
over repeated runs. The key harness metric is `dispatchTimingMiddleware`
(`src/common/dispatch-timing.ts`) — the synchronous time spent inside
`store.dispatch`, which on baseline includes the entire subscriber notification.

## Scenario A — `many-components-heavy-selector` (5,000 components)

A custom scenario where each component runs a non-trivial selector (a real
derive, not a bare `state.counter` read), so the `O(subscribers)` fan-out itself
is the long task. This is the clearest picture of the change:

| metric | `9.2.0` | this branch |
|---|--:|--:|
| **synchronous `dispatch` (avg)** — the notification fan-out | `8.9 ms` | **`0.05 ms`** |
| React p50 update (commit) | `12.1 ms` | **`5.6 ms`** |
| React p95 update — longest blocking commit | `20.3 ms` | **`7.0 ms`** |
| render passes over the run | ~76 | ~690 |
| dispatches processed | ~303 | ~398 |

The fan-out leaves the synchronous dispatch path (`8.9 → 0.05 ms`), and because
each chunk only feeds React ~5 ms of work before yielding, React's commits are
capped at the chunk budget too (p50 `5.6 ms`, p95 `7.0 ms` vs `12–20 ms`). Same
total work, split into ~9× more, individually short commits.

## Scenario B — `many-components-same-slice` (30,000 components, trivial selector)

The stock scenario, bumped to 30k components. Selector is `state => state.counter`,
so the fan-out is cheap and the long task is dominated by React's commit — this
shows the effect from the render side:

| metric | `9.2.0` | this branch |
|---|--:|--:|
| synchronous `dispatch` (avg) | `6.46 ms` | `0.10 ms` |
| React avg update (commit) | `70.6 ms` | `23.7 ms` |
| React p95 update — longest blocking commit | `96.9 ms` | `40.5 ms` |
| render passes over the run | 22 | 64 |
| dispatches processed in 20s | 20 | 36 |

## Reproducing

```bash
# 1. build this branch and stage it for the harness
cd react-redux && yarn build
cp -r dist package.json <benchmarks>/.yalc/react-redux/

# 2. in the benchmarks repo, add an alias in package.json dependencies:
#    "react-redux-9.2.0-optimized": "file:.yalc/react-redux"
pnpm install
pnpm exec playwright install chromium
pnpm build

# 3. run
pnpm exec tsx ./runBenchmarks.ts \
  -s many-components-heavy-selector -v 9.2.0 9.2.0-optimized -l 15 --json
```

### `many-components-heavy-selector` scenario source

`src/scenarios/many-components-heavy-selector/App.tsx`:

```tsx
import React from 'react'
import { useSelector } from 'react-redux'
import * as c from './constants'

interface RootState { counter: number }

function heavySelect(state: RootState, index: number): number {
  let acc = 0
  for (let k = 0; k < c.SELECTOR_WORK; k++) {
    acc += ((index + k) ^ state.counter) & 0xff
  }
  return acc & 0xffff
}

function Component({ index }: { index: number }) {
  const value = useSelector((state: RootState) => heavySelect(state, index))
  return <div>{value}</div>
}

export default function App() {
  return (
    <div>
      {Array.from({ length: c.NUMBER_OF_COMPONENTS }).map((_, index) => (
        <Component key={index} index={index} />
      ))}
    </div>
  )
}
```

`constants.ts`: `NUMBER_OF_COMPONENTS = 5000`, `SELECTOR_WORK = 1500`.
`stateSlice.ts` / `index.tsx` are copied from `many-components-same-slice`
(a `counter` slice dispatched via `setInterval(increment, 13)`).
