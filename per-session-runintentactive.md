# Per-Session runIntentActive

`runIntentActive` needs to change from `boolean` to `Record<string, boolean>` keyed by session ID.

## Declaration (line 161)

```ts
// Before
const [runIntentActive, setRunIntentActive] = useState(false);

// After
const [runIntentActive, setRunIntentActive] = useState<Record<string, boolean>>({});
```

## hasActiveRun (line 1082)

Change read + add `activeSessionId` to memo deps:

```ts
// Before (line 1082)
runIntentActive ||

// After
(activeSessionId ? (runIntentActive[activeSessionId] ?? false) : false) ||
```

Also add `activeSessionId` to the `useMemo` dependency array on the line that defines `hasActiveRun`.

## Effect 1344 (hasActiveRun effect)

```ts
// Before
useEffect(() => {
    if (!hasActiveRun) return;
    setRunIntentActive(true);
}, [hasActiveRun]);

// After
useEffect(() => {
    if (!hasActiveRun || !activeSessionId) return;
    setRunIntentActive(prev => ({...prev, [activeSessionId]: true}));
}, [hasActiveRun, activeSessionId]);
```

## Effect 1369 (runIntentActive guard)

```ts
// Before (line 1348)
if (!runIntentActive) {
    return;
}
...
setRunIntentActive(false);
}, [..., runIntentActive, ...]);

// After
if (!activeSessionId || !runIntentActive[activeSessionId]) {
    return;
}
...
setRunIntentActive(prev => ({...prev, [activeSessionId]: false}));
}, [..., activeSessionId, runIntentActive, ...]); // add activeSessionId
```

## SSE cleanup (line 2296) — clear all

```ts
// Before
setRunIntentActive(false);

// After
setRunIntentActive({});
```

## SSE idle debounce (line 2544)

```ts
// Before
setRunIntentActive(false);

// After
setRunIntentActive(prev => activeSessionId ? ({...prev, [activeSessionId]: false}) : prev);
```

## SSE busy handler (line 2556)

```ts
// Before
setRunIntentActive(true);

// After
setRunIntentActive(prev => activeSessionId ? ({...prev, [activeSessionId]: true}) : prev);
```

## Reset function (line 3147) — clear all

```ts
// Before
setRunIntentActive(false);

// After
setRunIntentActive({});
```

## handleSendMessage (line 3550)

```ts
// Before
setRunIntentActive(true);

// After
setRunIntentActive(prev => ({...prev, [result.sessionId]: true}));
```

## handleAbortGeneration (line 3612)

```ts
// Before
setRunIntentActive(true);

// After
setRunIntentActive(prev => activeSessionId ? ({...prev, [activeSessionId]: true}) : prev);
```

## handleAbortGeneration finally (line 3631)

```ts
// Before
setRunIntentActive(false);

// After
setRunIntentActive(prev => activeSessionId ? ({...prev, [activeSessionId]: false}) : prev);
```

## Summary

10 `setRunIntentActive` lines changed, 3 `runIntentActive` reads changed. All in `frontend/src/App.tsx`.

Dependency arrays to update:
- `hasActiveRun` `useMemo` — add `activeSessionId`
- Effect 1344 — add `activeSessionId`
- Effect 1369 — add `activeSessionId`
