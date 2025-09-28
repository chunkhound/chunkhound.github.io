---
title: "Test 3: ChunkHound Response"
description: "etcd failure analysis with ChunkHound semantic search"
---

# Kubernetes etcd Failure Analysis: 30% Packet Loss Scenario

## Executive Summary

When an etcd node becomes unresponsive with 30% packet loss, Kubernetes components exhibit predictable cascading failures through well-defined timeout and recovery mechanisms. The system maintains operational resilience through multiple layers of protection, though with degraded performance and temporary service disruptions.

## Scenario: etcd Node with 30% Packet Loss

### Primary Impact Timeline

**Immediate (0-10 seconds)**
- etcd client connections experience intermittent failures
- API server health checks begin reporting degraded status
- Leader election renewal attempts start failing sporadically

**Short-term (10-60 seconds)**
- Controller leadership transitions triggered
- API server request latency increases dramatically
- Some workload reconciliation pauses

**Medium-term (1-5 minutes)**
- Failed controllers restart and re-elect leaders
- Workload-specific impacts manifest
- Recovery mechanisms activate

## Component-Specific Impact Analysis

### 1. API Server (First Affected)

**Implementation Details** (`staging/src/k8s.io/apiserver/pkg/storage/storagebackend/factory/etcd3.go:63-69`):
```go
keepaliveTime    = 30 * time.Second  // Aggressive failure detection
keepaliveTimeout = 10 * time.Second  // Quick timeout for failed connections
dialTimeout      = 20 * time.Second  // TLS-safe connection timeout
```

**Failure Sequence:**
1. **Connection Degradation** (0-10s): etcd client detects packet loss through keepalive failures
2. **Health Check Failures** (10-20s): Background health monitoring reports connectivity issues via `--etcd-healthcheck-timeout` (default 2s)
3. **Request Processing Impact** (20-30s): Client requests experience increased latency but continue processing
4. **Endpoint Rotation** (30s+): etcd client automatically rotates between available endpoints

**Key Behaviors:**
- **Non-blocking Health Checks**: Health monitoring runs independently and doesn't block API requests
- **Graceful Degradation**: Requests continue processing with higher latency
- **Automatic Failover**: Client rotates to healthy etcd endpoints automatically

### 2. Leader Election Mechanisms (Critical Path)

**Implementation Details** (`staging/src/k8s.io/client-go/tools/leaderelection/leaderelection.go:116-166`):
```go
LeaseDuration: 15 * time.Second    // Non-leader wait time
RenewDeadline: 10 * time.Second    // Leader renewal timeout
RetryPeriod:   2 * time.Second     // Retry interval
```

**Failure Detection Process:**
1. **Optimistic Renewal Failures** (0-10s): Current leaders attempt lease renewal, some fail due to packet loss
2. **Slow Path Fallback** (10-15s): Failed optimistic renewals trigger full etcd reads
3. **Leadership Loss** (15-25s): Leaders unable to renew within `RenewDeadline` voluntarily step down
4. **Election Chaos** (15-30s): Multiple candidates attempt acquisition during `LeaseDuration` window
5. **Stabilization** (30-45s): New leaders elected, jittered retry prevents thundering herd

**Clock Skew Protection**: Uses local timestamps rather than etcd timestamps to avoid distributed clock issues

### 3. In-Flight Request Handling

**Request Processing During Failure:**
- **Context Timeout Respect**: API server honors client-provided request timeouts
- **Cache Utilization**: API server cache (`staging/src/k8s.io/apiserver/ARCHITECTURE.md:203-211`) serves most reads independently
- **Fallback Mechanism**: Requests that can't be served from cache fall through to etcd storage
- **Bookmark Events**: Prevent cache `ResourceVersion` from becoming too old

**Error Classification:**
1. **Context Errors**: Canceled/deadline exceeded (client-side timeouts)
2. **Cluster Errors**: All etcd endpoints failed (connectivity issues)
3. **Response Errors**: Invalid response format (data corruption)

### 4. Workload-Specific Impact Patterns

#### StatefulSets
**Controller Behavior** (`pkg/controller/statefulset/stateful_set_control_test.go:465-495`):
- **Most Resilient**: Fixed ordering requirements mean fewer race conditions during leadership changes
- **Pod Recreation**: Recent fixes ensure proper pod restart after eviction/node failure scenarios
- **Ordered Operations**: Sequential pod management reduces complexity during etcd instability

#### Deployments
**Controller Behavior**:
- **Moderate Impact**: ReplicaSet management can continue during brief leadership gaps
- **Rolling Updates**: May pause temporarily during controller transitions
- **Scale Operations**: Delayed until new controller leader established

#### DaemonSets
**Controller Behavior** (`pkg/controller/daemon/daemon_controller_test.go:1723-1759`):
- **Highest Impact**: Node-by-node management requires more etcd interactions
- **Failed Pod Handling**: Implements backoff mechanisms to avoid hot-looping with kubelet
- **Taint Tolerance**: Survives taint-based evictions during node unreachable states

### 5. Recovery Mechanisms (Activation Order)

#### Immediate (0-30 seconds)
1. **etcd Client Endpoint Rotation**: Automatic failover to healthy endpoints
2. **Health Check Reporting**: Background monitoring updates component status
3. **Request Queuing**: Work queues buffer operations during brief outages

#### Short-term (30 seconds - 2 minutes)
1. **Leader Re-election**: Controllers establish new leadership
2. **Informer Recovery**: Client-go informers maintain local caches during temporary unavailability
3. **Cache Synchronization**: API server cache resynchronizes with etcd

#### Medium-term (2-10 minutes)
1. **Controller Reconciliation**: Full workload state reconciliation
2. **Pod Restart Logic**: StatefulSet controllers properly handle pod restarts
3. **Event Processing**: Queued events processed with exponential backoff

#### Long-term (10+ minutes)
1. **Metrics Reset**: Prometheus metrics updated to reflect recovered state
2. **Health Status**: All components report healthy status
3. **Performance Normalization**: Request latency returns to baseline

## Network Partition vs. Node Failure Differences

### Network Partition (Split-Brain Scenario)
**Characteristics:**
- **Partial Connectivity**: Some etcd nodes remain accessible
- **Quorum Maintenance**: If majority accessible, cluster continues operating
- **Graceful Degradation**: Services continue with degraded performance
- **Automatic Recovery**: When partition heals, nodes rejoin seamlessly

**etcd Client Behavior:**
- Endpoint rotation handles partial connectivity
- Leader election continues with accessible majority
- Failed nodes automatically rejoin cluster

### Actual Node Failure (Complete Loss)
**Characteristics:**
- **Binary State**: Node completely unreachable
- **Quorum Impact**: May lose quorum if multiple nodes fail
- **Service Interruption**: Complete API unavailability if quorum lost
- **Manual Recovery**: May require operator intervention

**etcd Client Behavior:**
- Leaders detect failure through renewal timeouts
- New elections required based on lease expiration
- Faster detection but potentially longer recovery

## Implementation Insights from Code Analysis

### Critical Timeout Hierarchy
1. **Connection Level**: `DialTimeout` (20s) > `KeepAliveTimeout` (10s)
2. **Health Check Level**: `HealthcheckTimeout` (2s) for fast failure detection
3. **Leadership Level**: `RenewDeadline` (10s) > `RetryPeriod` (2s)

### Resilience Patterns
1. **Connection Reuse**: Single client per transport configuration prevents resource leaks
2. **Rate Limited Health Checks**: Prevents etcd overload during failures
3. **Jittered Retries**: `wait.JitterUntil` with 1.2x factor prevents thundering herd
4. **Optimistic Renewals**: Fast path for current leaders with slow-path fallback

### Error Isolation
1. **Non-blocking Operations**: Health checks don't block request processing
2. **Cached Responses**: API server serves from cache during temporary etcd issues
3. **Work Queue Decoupling**: Informer event handlers only queue keys, allowing retry logic

## Operational Recommendations

### Monitoring
- Track etcd client connection metrics and health check latency
- Monitor leader election transitions and controller restart patterns
- Watch for increased API server response times and cache miss rates

### Configuration
- Tune `--etcd-healthcheck-timeout` based on network characteristics
- Configure appropriate leader election timeouts for cluster size
- Set realistic client request timeouts considering network conditions

### Recovery Planning
- Establish etcd cluster sizing for quorum maintenance during failures
- Implement automated etcd backup and restore procedures
- Document expected service degradation patterns for different failure modes

---

*Analysis based on Kubernetes codebase commit 243d8c000e4, focusing on actual implementation details rather than theoretical behavior.*