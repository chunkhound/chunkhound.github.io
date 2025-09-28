---
title: "Test 2: ChunkHound Response"
description: "Deployment controller analysis with ChunkHound semantic search"
---

# Kubernetes Deployment Controller: Deep Architecture Analysis

## Executive Summary

This document provides a comprehensive analysis of the Kubernetes Deployment controller implementation, examining its architecture, patterns, and mechanisms for handling complex orchestration scenarios. The analysis reveals a sophisticated system built on the controller-runtime pattern with robust race condition prevention and conflict resolution capabilities.

## Table of Contents

1. [Controller-Runtime Pattern Implementation](#controller-runtime-pattern-implementation)
2. [Reconcile Loop Architecture](#reconcile-loop-architecture)
3. [Deployment vs ReplicaSet Controller Comparison](#deployment-vs-replicaset-controller-comparison)
4. [Conflict Handling in Concurrent Reconciliations](#conflict-handling-in-concurrent-reconciliations)
5. [Strategic Merge Patches vs Three-Way Merges](#strategic-merge-patches-vs-three-way-merges)
6. [Orphaned ReplicaSet Handling During Rollbacks](#orphaned-replicaset-handling-during-rollbacks)
7. [Race Condition Prevention Mechanisms](#race-condition-prevention-mechanisms)
8. [Key Findings and Recommendations](#key-findings-and-recommendations)

---

## Controller-Runtime Pattern Implementation

### Architecture Overview

The Deployment controller implements the standard Kubernetes controller pattern with these core components:

**Location**: `pkg/controller/deployment/deployment_controller.go:66-98`

```go
type DeploymentController struct {
    rsControl     controller.RSControlInterface
    client        clientset.Interface
    eventRecorder record.EventRecorder

    // Shared informers
    dLister       appslisters.DeploymentLister
    rsLister      appslisters.ReplicaSetLister
    podLister     corelisters.PodLister

    // Work queue with rate limiting
    queue workqueue.TypedRateLimitingInterface[string]
    syncHandler func(ctx context.Context, dKey string) error
}
```

### Key Design Patterns

1. **Event-Driven Architecture**: Uses shared informers with event handlers for Add/Update/Delete operations
2. **Work Queue Serialization**: Ensures single-threaded processing per deployment key
3. **Rate-Limited Retries**: Exponential backoff with maximum 15 retries (5ms to 82s)
4. **Expectations Framework**: Prevents duplicate operations during eventual consistency windows

### Integration Points

- **Shared Informers**: Monitors Deployments, ReplicaSets, and Pods
- **Controller Manager**: Integrates with standard Kubernetes controller lifecycle
- **API Server**: Uses optimistic concurrency control via resource versions
- **Work Queue**: Serializes work and provides failure handling

---

## Reconcile Loop Architecture

### Core Reconciliation Flow

**Location**: `pkg/controller/deployment/sync.go:57-77`

The reconcile loop follows this sequence:

1. **Resource Discovery**: Get all ReplicaSets and sync revision numbers
2. **Strategy Routing**: Choose between Rolling Update, Recreate, or Scaling operations
3. **ReplicaSet Management**: Scale ReplicaSets proportionally based on strategy
4. **Cleanup Operations**: Remove old ReplicaSets when safe
5. **Status Updates**: Update deployment status and conditions

### Strategy-Based Reconciliation

**Rolling Update Implementation** (`pkg/controller/deployment/rolling.go:31-66`):

```go
// Scale up, if we can.
scaledUp, err := dc.reconcileNewReplicaSet(ctx, allRSs, newRS, d)
// Scale down, if we can.
scaledDown, err := dc.reconcileOldReplicaSets(ctx, allRSs,
    controller.FilterActiveReplicaSets(oldRSs), newRS, d)
```

The rolling update strategy implements sophisticated scaling logic:
- Calculates `maxScaledDown` based on availability constraints
- Cleans up unhealthy replicas first to prevent blocking
- Considers `maxUnavailable` and `maxSurge` parameters
- Maintains proportional scaling across multiple ReplicaSets

### State Management

- **Resource Versions**: Used for optimistic concurrency control
- **Revision Annotations**: Track deployment history for rollbacks
- **Collision Counters**: Handle hash collisions in ReplicaSet naming
- **Controller References**: Manage ownership relationships

---

## Deployment vs ReplicaSet Controller Comparison

### Architectural Differences

| Aspect | Deployment Controller | ReplicaSet Controller |
|--------|----------------------|----------------------|
| **Management Level** | Two-hop (Deployment → ReplicaSet → Pod) | Single-hop (ReplicaSet → Pod) |
| **Resource Coordination** | Multi-ReplicaSet orchestration | Direct Pod management |
| **Reconciliation Complexity** | Strategy-based with rollout logic | Simple diff-based scaling |
| **Conflict Resolution** | Delegates to ReplicaSet controllers | Uses expectations pattern |
| **History Management** | Maintains revision history | No historical tracking |

### ReplicaSet Controller Characteristics

**Location**: `pkg/controller/replicaset/replica_set.go:702-785`

- **Direct Pod Management**: Creates/deletes pods directly via `PodControlInterface`
- **Expectations Tracking**: Uses `UIDTrackingControllerExpectations` for race prevention
- **Burst Control**: Limits concurrent operations (`burstReplicas = 500`)
- **Slow Start Batching**: Exponential batching for pod creation

### Deployment Controller Characteristics

**Location**: `pkg/controller/deployment/deployment_controller.go:590+`

- **Indirect Management**: Scales ReplicaSets which manage Pods
- **Strategy Pattern**: Different logic for Rolling vs Recreate deployments
- **Multi-Resource Coordination**: Manages multiple ReplicaSets simultaneously
- **Progressive Rollouts**: Coordinates complex multi-step deployment scenarios

### Key Behavioral Differences

1. **Failure Handling**: ReplicaSet handles pod-level failures; Deployment handles ReplicaSet-level failures
2. **Scaling Logic**: ReplicaSet uses simple replica diff; Deployment uses complex proportional scaling
3. **Resource Lifecycle**: ReplicaSet manages Pod lifecycle; Deployment manages ReplicaSet lifecycle
4. **Event Complexity**: ReplicaSet events are Pod-focused; Deployment events span multiple ReplicaSets

---

## Conflict Handling in Concurrent Reconciliations

### Multi-Layer Conflict Resolution

The Deployment controller implements several mechanisms to handle concurrent reconciliations:

#### 1. Work Queue Serialization

**Location**: `pkg/controller/deployment/deployment_controller.go:481-498`

```go
func (dc *DeploymentController) processNextWorkItem(ctx context.Context) bool {
    key, quit := dc.queue.Get()
    if quit {
        return false
    }
    defer dc.queue.Done(key)  // Ensures atomic processing

    err := dc.syncHandler(ctx, key)
    dc.handleErr(ctx, err, key)
    return true
}
```

- **Single Worker Per Key**: Prevents concurrent processing of the same deployment
- **Atomic Processing**: Work items are marked done regardless of success/failure
- **Rate Limiting**: Failed items are requeued with exponential backoff

#### 2. Resource Version Checks

**Location**: `pkg/controller/deployment/deployment_controller.go:278-282`

```go
if curRS.ResourceVersion == oldRS.ResourceVersion {
    // Two different versions of the same replica set will always have different RVs.
    return  // Skip processing duplicate events
}
```

- **Optimistic Concurrency**: API server enforces resource version preconditions
- **Duplicate Event Filtering**: Prevents processing stale cache events
- **Conflict Detection**: Update failures trigger requeue with backoff

#### 3. Hash Collision Resolution

**Location**: `pkg/controller/deployment/sync.go:242-271`

```go
// If hash collision detected, increment collision counter and requeue
if d.Status.CollisionCount == nil {
    d.Status.CollisionCount = new(int32)
}
*d.Status.CollisionCount++
```

- **Deterministic Naming**: ReplicaSets use template hash for naming
- **Collision Detection**: Compares template semantics vs name collisions
- **Automatic Recovery**: Increments counter and retries with new name

#### 4. Controller Reference Management

**Location**: `pkg/controller/controller_ref_manager.go:319-343`

- **Atomic Ownership Changes**: Uses strategic merge patches for controller references
- **Adoption/Release Logic**: Handles orphaned resources safely
- **Deletion Protection**: Prevents adoption during controller deletion

### Conflict Scenarios and Resolution

| Conflict Type | Detection Method | Resolution Strategy |
|---------------|------------------|---------------------|
| **Concurrent Updates** | Resource version mismatch | Requeue with exponential backoff |
| **Hash Collisions** | Template comparison | Increment collision counter, retry |
| **Orphaned Resources** | Missing controller reference | Adopt via strategic merge patch |
| **Cache Staleness** | Resource version comparison | Skip processing, wait for fresh event |
| **API Server Conflicts** | Update operation failure | Rate-limited requeue |

---

## Strategic Merge Patches vs Three-Way Merges

### Strategic Merge Patch Implementation

**Location**: `staging/src/k8s.io/apimachinery/pkg/util/strategicpatch/patch.go`

Strategic merge patches provide Kubernetes-native field semantics with advanced merge capabilities:

#### Key Features

1. **Field-Level Merge Strategies**: Uses struct tags to define merge behavior
2. **List Merging by Key**: Merges array elements by specified keys rather than replacing entire arrays
3. **Special Directives**: Supports `$patch: delete`, `$patch: replace`, and ordering directives
4. **Semantic Awareness**: Understands Kubernetes resource field semantics

#### Deployment Usage Examples

**Deployment Status Conditions** (`staging/src/k8s.io/api/apps/v1/types.go:520-523`):

```go
// +patchMergeKey=type
// +patchStrategy=merge
Conditions []DeploymentCondition `json:"conditions,omitempty" patchStrategy:"merge" patchMergeKey:"type"`
```

- **Merge Strategy**: Individual conditions are merged by `type` field
- **Preservation**: Existing conditions not in patch are preserved
- **Update Semantics**: Only specified condition types are modified

### Three-Way Merge Implementation

**Location**: `staging/src/k8s.io/apimachinery/pkg/util/strategicpatch/patch.go:2094-2181`

Three-way merges reconcile conflicts between three document states:

#### Algorithm

1. **Original**: Last known state of the resource
2. **Modified**: User's desired state (kubectl apply input)
3. **Current**: Live cluster state from API server

```go
func CreateThreeWayMergePatch(original, modified, current []byte,
    dataStruct interface{}, overwrite bool) ([]byte, error) {

    // Compute differences between current and modified
    patchDelta, err := createMapDelta(currentMap, modifiedMap, ...)

    // Find deletions from original to modified
    patchDeletions, err := diffMaps(originalMap, modifiedMap, ...)

    // Merge deletions and delta changes
    mergedPatch := mergeMap(patchDelta, patchDeletions, ...)

    return json.Marshal(mergedPatch)
}
```

#### Conflict Detection

- **Overlapping Changes**: Detects when current and modified states have conflicting modifications
- **Safety Checks**: Returns `ErrConflict` when conflicting changes detected
- **Force Override**: Optional overwrite mode bypasses conflict detection

### Usage Patterns in Kubernetes

| Operation | Patch Type | Use Case |
|-----------|------------|----------|
| **kubectl apply** | Three-way merge | Declarative resource management |
| **Status Updates** | Strategic merge | Controller status reporting |
| **Ownership Changes** | Strategic merge | Controller reference updates |
| **Admission Controllers** | JSON Patch | Precise field modifications |

### Strategic vs Standard Patches

**Strategic Merge Advantages**:
- Kubernetes-native field semantics
- Intelligent list merging by keys
- Special directive support
- Preserves unspecified fields

**JSON Patch Advantages**:
- Precise path-based operations
- Universal JSON compatibility
- Atomic operation guarantees
- No schema dependencies

---

## Orphaned ReplicaSet Handling During Rollbacks

### Rollback Architecture

**Location**: `pkg/controller/deployment/rollback.go:33-151`

The rollback mechanism handles orphaned ReplicaSets through a multi-stage process:

#### 1. Rollback Initiation

```go
func (dc *DeploymentController) rollback(ctx context.Context, d *apps.Deployment,
    rsList []*apps.ReplicaSet) error {

    // Find target revision (0 = previous revision)
    if d.Spec.RollbackTo.Revision == 0 {
        d.Spec.RollbackTo.Revision = deploymentutil.LastRevision(rsList)
    }

    // Locate target ReplicaSet
    for _, rs := range rsList {
        if deploymentutil.Revision(rs) == d.Spec.RollbackTo.Revision {
            return dc.rollbackToTemplate(ctx, d, rs)
        }
    }
}
```

#### 2. Orphaned ReplicaSet Detection

**Location**: `pkg/controller/deployment/deployment_controller.go:238-248`

```go
// Handle orphaned ReplicaSets
if controllerRef == nil {
    // Get all matching Deployments and sync them for potential adoption
    ds := dc.getDeploymentsForReplicaSet(logger, rs)
    for _, d := range ds {
        dc.enqueueDeployment(d)
    }
    return
}
```

#### 3. Adoption/Release Logic

**Location**: `pkg/controller/controller_ref_manager.go:319-385`

```go
func (m *BaseControllerRefManager) ClaimReplicaSets(sets []*apps.ReplicaSet,
    filters ...func(*apps.ReplicaSet) bool) ([]*apps.ReplicaSet, error) {

    var claimed []*apps.ReplicaSet
    var errlist []error

    match := func(obj metav1.Object) bool {
        return m.Selector.Matches(labels.Set(obj.GetLabels()))
    }

    adopt, release, err := m.classifyControllerRef(sets, match)

    // Adopt orphaned ReplicaSets that match
    for _, rs := range adopt {
        err := m.AdoptReplicaSet(rs)
        if err != nil {
            errlist = append(errlist, err)
            continue
        }
        claimed = append(claimed, rs)
    }

    // Release owned ReplicaSets that no longer match
    for _, rs := range release {
        err := m.ReleaseReplicaSet(rs)
        if err != nil {
            errlist = append(errlist, err)
            continue
        }
    }

    return claimed, utilerrors.NewAggregate(errlist)
}
```

### Orphaned ReplicaSet Scenarios

#### Scenario 1: Controller Restart During Rollback

**Problem**: Deployment controller crashes during rollback, leaving ReplicaSets without proper ownership

**Solution**:
1. On restart, informer events trigger deployment reconciliation
2. `ClaimReplicaSets()` identifies orphaned ReplicaSets matching selector
3. Strategic merge patch atomically sets controller reference
4. Normal reconciliation proceeds with proper ownership

#### Scenario 2: Manual ReplicaSet Creation

**Problem**: User manually creates ReplicaSet that matches deployment selector

**Solution**:
1. ReplicaSet creation event triggers `addReplicaSet()` handler
2. Missing controller reference detected → orphan identified
3. All matching deployments enqueued for reconciliation
4. First matching deployment adopts the ReplicaSet

#### Scenario 3: Selector Changes During Rollback

**Problem**: Deployment selector modified during rollback, causing ownership mismatch

**Solution**:
1. Deployment update triggers reconciliation
2. `ClaimReplicaSets()` identifies mismatched owned ReplicaSets
3. `ReleaseReplicaSet()` removes controller reference from non-matching ReplicaSets
4. Released ReplicaSets become orphans and may be adopted by other controllers

### Safety Mechanisms

#### 1. Adoption Validation

**Location**: `pkg/controller/controller_ref_manager.go:348-359`

```go
func (m *BaseControllerRefManager) AdoptReplicaSet(rs *apps.ReplicaSet) error {
    if err := m.CanAdoptFunc()(rs); err != nil {
        return fmt.Errorf("can't adopt ReplicaSet %v/%v: %v", rs.Namespace, rs.Name, err)
    }
    // Atomic ownership update via strategic merge patch
    return m.rsControl.AdoptRS(m.Controller, rs)
}
```

#### 2. Deletion Protection

```go
func RecheckDeletionTimestamp(cur metav1.Object) func(metav1.Object) error {
    return func(obj metav1.Object) error {
        if cur.GetDeletionTimestamp() != nil {
            return fmt.Errorf("%v/%v has just been deleted at %v",
                cur.GetNamespace(), cur.GetName(), cur.GetDeletionTimestamp())
        }
        return nil
    }
}
```

#### 3. Revision History Management

**Location**: `pkg/controller/deployment/util/deployment_util.go:185-293`

- **History Preservation**: Maintains specified number of ReplicaSet revisions
- **Cleanup Safety**: Only deletes ReplicaSets with zero replicas
- **Annotation Management**: Tracks revision numbers and change causes

### Rollback Edge Cases

| Edge Case | Detection | Resolution |
|-----------|-----------|------------|
| **Multiple Adoptions** | Controller reference conflicts | First adopter wins, others fail gracefully |
| **Revision History Gaps** | Missing revision annotation | Use creation timestamp ordering |
| **Template Hash Collisions** | Same hash, different templates | Increment collision counter, retry |
| **Concurrent Rollbacks** | Multiple rollback annotations | Process serially via work queue |

---

## Race Condition Prevention Mechanisms

### Multi-Layer Protection Strategy

The Deployment controller implements comprehensive race condition prevention through multiple coordinated mechanisms:

#### 1. Work Queue Serialization

**Location**: `pkg/controller/deployment/deployment_controller.go:108-114`

```go
queue: workqueue.NewTypedRateLimitingQueueWithConfig(
    workqueue.DefaultTypedControllerRateLimiter[string](),
    workqueue.TypedRateLimitingQueueConfig[string]{
        Name: "deployment",
    },
)
```

**Rate Limiting Strategy**:
- Exponential backoff: 5ms, 10ms, 20ms, 40ms, 80ms, 160ms, 320ms, 640ms, 1.3s, 2.6s, 5.1s, 10.2s, 20.4s, 41s, 82s
- Maximum 15 retries before giving up
- Per-key serialization prevents concurrent processing

#### 2. Expectations Framework

**Location**: `pkg/controller/controller_utils.go:131-399`

```go
type ControlleeExpectations struct {
    add       int64  // Atomic operations
    del       int64  // Atomic operations
    key       string
    timestamp time.Time
}

func (e *ControlleeExpectations) Fulfilled() bool {
    return atomic.LoadInt64(&e.add) <= 0 && atomic.LoadInt64(&e.del) <= 0
}
```

**Protection Mechanisms**:
- **Atomic Counters**: Thread-safe expectation tracking
- **Timeout Protection**: 5-minute expiration prevents stuck controllers
- **UID Tracking**: Prevents double-counting of graceful deletions

#### 3. Optimistic Concurrency Control

**Resource Version Validation**:
```go
if curRS.ResourceVersion == oldRS.ResourceVersion {
    // Skip duplicate/stale events
    return
}
```

**Update Conflict Handling**:
```go
// Hash collision detection and resolution
if d.Status.CollisionCount == nil {
    d.Status.CollisionCount = new(int32)
}
*d.Status.CollisionCount++
// Requeue for retry with new hash
```

### Critical Race Condition Scenarios

#### Race Condition 1: Cache vs API Server Inconsistency

**Scenario**: Local informer cache shows object exists, but API server has deleted it

**Test Case**: `pkg/controller/deployment/deployment_controller_test.go:304-328`

```go
func TestSyncDeploymentDeletionRace(t *testing.T) {
    // Lister (cache) says NOT deleted
    f.dLister = append(f.dLister, d)
    // Client says it IS deleted (more authoritative)
    now := metav1.Now()
    d2.DeletionTimestamp = &now
    f.objects = append(f.objects, &d2)

    // Expect fresh API server lookup to resolve inconsistency
    f.expectGetDeploymentAction(d)
    // Sync fails and requeues to let cache catch up
}
```

**Prevention**:
- Fresh API server lookup when inconsistencies detected
- Sync failure triggers requeue with backoff
- Only proceed when cache and API server state align

#### Race Condition 2: Duplicate Resource Creation

**Scenario**: Multiple reconcile cycles attempt to create the same ReplicaSet

**Prevention via Expectations**:
```go
func (r *ControllerExpectations) SatisfiedExpectations(logger klog.Logger, controllerKey string) bool {
    if exp, exists, err := r.GetExpectations(controllerKey); exists {
        if exp.Fulfilled() {
            return true  // Proceed
        } else if exp.isExpired() {
            return true  // Timeout - proceed anyway
        } else {
            return false  // Block until expectations met
        }
    }
    return true  // No expectations - proceed
}
```

**Flow**:
1. Before creation: Set expectations for number of creates
2. API call: Attempt resource creation
3. Informer event: Decrement expectation counter
4. Subsequent syncs: Blocked until expectations satisfied

#### Race Condition 3: Graceful Deletion Double-Counting

**Scenario**: Pod with DeletionTimestamp is counted as both existing and deleted

**UID Tracking Solution**:
```go
func (u *UIDTrackingControllerExpectations) DeletionObserved(logger klog.Logger, rcKey, deleteKey string) {
    u.uidStoreLock.Lock()
    defer u.uidStoreLock.Unlock()

    uids := u.GetUIDs(rcKey)
    if uids != nil && uids.Has(deleteKey) {
        u.ControllerExpectationsInterface.DeletionObserved(logger, rcKey)
        uids.Delete(deleteKey)  // Remove from tracking set
    }
}
```

**Protection**:
- Track UIDs of resources expected to be deleted
- When DeletionTimestamp appears, count as deletion for that specific UID
- Prevents same resource deletion from being counted multiple times

#### Race Condition 4: Informer Event Loss

**Scenario**: Network partition or informer restart causes missed events

**Recovery Mechanisms**:
- **Expectation Timeout**: Automatic 5-minute expiration allows recovery
- **Periodic Resync**: Informers periodically refresh entire cache
- **State Reconciliation**: Controllers compare desired vs actual state

### Cache Consistency Guarantees

#### Informer Cache Synchronization

```go
if !cache.WaitForNamedCacheSyncWithContext(ctx, dc.dListerSynced, dc.rsListerSynced, dc.podListerSynced) {
    utilruntime.HandleError(fmt.Errorf("timed out waiting for caches to sync"))
    return
}
```

#### Tombstone Handling

**Location**: `pkg/controller/deployment/deployment_controller.go:200-216`

```go
func (dc *DeploymentController) deleteDeployment(logger klog.Logger, obj interface{}) {
    d, ok := obj.(*apps.Deployment)
    if !ok {
        tombstone, ok := obj.(cache.DeletedFinalStateUnknown)
        if !ok {
            utilruntime.HandleError(fmt.Errorf("couldn't get object from tombstone %#v", obj))
            return
        }
        d, ok = tombstone.Obj.(*apps.Deployment)
        // ... handle tombstone object
    }
    dc.enqueueDeployment(d)
}
```

**Protections**:
- **Cache Warm-up**: Controllers wait for initial cache sync before processing
- **Tombstone Recovery**: Special objects handle missed deletion events
- **Eventually Consistent**: Controllers tolerate temporary cache inconsistency

---

## Key Findings and Recommendations

### Architecture Strengths

1. **Robust Conflict Resolution**: Multi-layer protection against race conditions
2. **Strategic Resource Management**: Intelligent ReplicaSet lifecycle orchestration
3. **Comprehensive Error Handling**: Graceful degradation with exponential backoff
4. **Event-Driven Design**: Efficient response to cluster state changes
5. **Pluggable Strategies**: Clean separation between Rolling and Recreate logic

### Potential Improvements

1. **Memory Optimization**: UID tracking stores could be optimized for high-churn environments
2. **Observability**: Additional metrics around expectation satisfaction and queue depth
3. **Timeout Tuning**: Configurable expectation timeouts for different deployment patterns
4. **Test Coverage**: More comprehensive testing of edge cases and race conditions

### Reusable Patterns

1. **Controller Expectations Framework**: Applicable to any controller managing resources
2. **Work Queue Serialization**: Standard pattern for Kubernetes controllers
3. **Strategic Merge Patches**: Best practice for atomic ownership changes
4. **Informer Event Handling**: Template for cache-based controllers

### Production Considerations

1. **Resource Limits**: Controllers should monitor memory usage during high pod churn
2. **Rate Limiting**: Tune retry policies based on cluster size and API server capacity
3. **Monitoring**: Track expectation satisfaction rates and queue depth
4. **Testing**: Validate behavior under network partitions and high concurrency

The Kubernetes Deployment controller represents a mature, production-ready implementation of distributed system coordination patterns, demonstrating how to build reliable controllers that gracefully handle the complexities of eventual consistency, concurrent operations, and failure scenarios in distributed environments.

---

## File References

- **Main Controller**: `pkg/controller/deployment/deployment_controller.go`
- **Reconciliation Logic**: `pkg/controller/deployment/sync.go`
- **Rolling Updates**: `pkg/controller/deployment/rolling.go`
- **Rollback Implementation**: `pkg/controller/deployment/rollback.go`
- **Utility Functions**: `pkg/controller/deployment/util/deployment_util.go`
- **Controller Expectations**: `pkg/controller/controller_utils.go`
- **Strategic Merge Patches**: `staging/src/k8s.io/apimachinery/pkg/util/strategicpatch/`
- **ReplicaSet Controller**: `pkg/controller/replicaset/replica_set.go`
- **Controller Reference Manager**: `pkg/controller/controller_ref_manager.go`

*Analysis completed based on Kubernetes source code examination and architectural research.*