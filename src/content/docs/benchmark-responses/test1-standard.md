---
title: "Test 1: Standard Claude Response"
description: "kubectl apply flow analysis with standard Claude Code"
---

# Complete Code Path: kubectl apply -f deployment.yaml to Running Pods

This document traces the complete execution path from running `kubectl apply -f deployment.yaml` to pods running on nodes, identifying all major components, key functions, and data structures involved.

## Overview

The journey from `kubectl apply` to running pods involves 6 major components working in coordination:

1. **kubectl Client** - Parses YAML, applies to API server
2. **API Server** - Validates, stores, and notifies watchers
3. **Deployment Controller** - Creates/manages ReplicaSets
4. **ReplicaSet Controller** - Creates/manages Pods
5. **Scheduler** - Assigns pods to nodes
6. **Kubelet** - Manages pod lifecycle on nodes

## 1. kubectl Client Processing

### Key Files:
- `staging/src/k8s.io/kubectl/pkg/cmd/apply/apply.go`

### Flow:
1. **Command Entry Point**: `NewCmdApply()` creates cobra command
2. **Options Creation**: `ToOptions()` converts flags to `ApplyOptions`
3. **Main Execution**: `Run()` method in `ApplyOptions`

### Key Functions:
- `apply.go:499` - `Run()`: Main apply execution logic
- `apply.go:516` - `GetObjects()`: Parses YAML files into resource.Info objects
- `apply.go:532` - `applyOneObject()`: Processes each object individually

### Data Structures:
- `ApplyOptions`: Contains all configuration for apply operation
- `resource.Info`: Represents a single Kubernetes object with metadata
- `unstructured.Unstructured`: Generic object representation

### Process:
1. Parse deployment.yaml into `resource.Info` objects
2. For each object, determine if server-side or client-side apply
3. Create HTTP PATCH/POST request to API server
4. Send request using `helper.Patch()` or `helper.Create()`

## 2. API Server Request Handling

### Key Files:
- `pkg/registry/apps/deployment/storage/storage.go`
- Generic REST storage and registry components

### Flow:
1. **HTTP Request Reception**: API server receives PATCH/POST request
2. **Authentication & Authorization**: Verifies client permissions
3. **Validation**: Validates deployment spec using OpenAPI schema
4. **Storage**: Persists to etcd via storage layer

### Key Functions:
- `storage.go:50+` - Storage layer for Deployment resources
- Validation using `appsvalidation` package
- etcd storage via `genericregistry.Store`

### Data Structures:
- `apps.Deployment`: Internal representation of deployment
- `metav1.Object`: Standard Kubernetes object metadata
- Storage backend abstractions

### Process:
1. Decode incoming request body to Deployment object
2. Validate deployment specification
3. Store in etcd with proper metadata (UID, resourceVersion, etc.)
4. Notify watchers via watch channels

## 3. Deployment Controller

### Key Files:
- `pkg/controller/deployment/deployment_controller.go`
- `pkg/controller/deployment/sync.go`

### Flow:
1. **Watch Events**: Receives Deployment creation event from API server
2. **Queue Processing**: Adds deployment to work queue
3. **Reconciliation**: Syncs actual state with desired state

### Key Functions:
- `deployment_controller.go:120` - `addDeployment()`: Handles new deployment events
- `deployment_controller.go:590` - `syncDeployment()`: Main reconciliation logic
- `sync.go:57` - `sync()`: Reconciles deployments on scaling events

### Key Structures:
- `DeploymentController`: Main controller struct with informers and listers
- `workqueue.TypedRateLimitingInterface`: Work queue for processing events

### Process:
1. Deployment informer receives ADD event
2. `addDeployment()` enqueues deployment key
3. Worker thread calls `syncDeployment()`
4. Controller creates/updates ReplicaSet based on deployment spec
5. Uses `rsControl.CreateReplicaSet()` to create new ReplicaSet

## 4. ReplicaSet Controller Coordination

### Key Files:
- `pkg/controller/replicaset/replica_set.go`

### Flow:
1. **ReplicaSet Creation**: Deployment controller creates ReplicaSet
2. **Pod Management**: ReplicaSet controller creates required pods
3. **Scaling**: Maintains desired number of pod replicas

### Key Functions:
- `replica_set.go:100+` - `NewReplicaSetController()`: Controller initialization
- `syncReplicaSet()`: Main reconciliation function for ReplicaSets
- `manageReplicas()`: Creates/deletes pods to match desired replicas

### Key Structures:
- `ReplicaSetController`: Main controller managing ReplicaSets
- `controller.PodControlInterface`: Interface for pod creation/deletion

### Process:
1. ReplicaSet informer receives ADD event
2. Controller calculates difference between desired and actual pods
3. Creates pods using `podControl.CreatePods()`
4. Each pod gets proper labels and owner references

## 5. Scheduler Pod Assignment

### Key Files:
- `pkg/scheduler/scheduler.go`
- Scheduler framework and plugins

### Flow:
1. **Pod Detection**: Scheduler watches for unscheduled pods
2. **Node Selection**: Runs filtering and scoring algorithms
3. **Binding**: Assigns pod to selected node

### Key Functions:
- `scheduler.go:83` - `NextPod()`: Gets next unscheduled pod from queue
- `scheduler.go:91` - `SchedulePod()`: Main scheduling function
- Node filtering and scoring via framework plugins

### Key Structures:
- `Scheduler`: Main scheduler struct with queue and framework
- `framework.QueuedPodInfo`: Pod waiting to be scheduled
- `ScheduleResult`: Result containing selected node

### Process:
1. Scheduler queue receives pod creation event
2. `NextPod()` dequeues pod for scheduling
3. Framework runs Filter plugins to find feasible nodes
4. Framework runs Score plugins to rank nodes
5. Best node selected and binding created
6. Pod.Spec.NodeName updated via API server

## 6. Kubelet Pod Lifecycle Management

### Key Files:
- `cmd/kubelet/kubelet.go`
- `pkg/kubelet/pod/pod_manager.go`

### Flow:
1. **Pod Assignment Detection**: Kubelet watches for pods assigned to its node
2. **Container Runtime**: Communicates with container runtime (Docker, containerd)
3. **Pod Lifecycle**: Manages complete pod lifecycle

### Key Functions:
- `pod_manager.go:45+` - Pod manager interface and implementation
- Kubelet sync loop processing assigned pods
- Container runtime interface (CRI) calls

### Key Structures:
- `Manager`: Pod manager storing and tracking pods
- `kubecontainer.Pod`: Container representation of pods
- CRI interfaces for container operations

### Process:
1. Kubelet watches API server for pods with matching `NodeName`
2. Pod manager tracks pods assigned to node
3. Kubelet communicates with container runtime via CRI
4. Runtime pulls images and starts containers
5. Kubelet reports pod status back to API server

## Data Flow Summary

```
kubectl apply
    ↓ (HTTP PATCH/POST)
API Server → etcd
    ↓ (Watch Event)
Deployment Controller
    ↓ (Creates)
ReplicaSet
    ↓ (Watch Event)
ReplicaSet Controller
    ↓ (Creates)
Pod (unscheduled)
    ↓ (Watch Event)
Scheduler
    ↓ (Updates pod.spec.nodeName)
Pod (scheduled)
    ↓ (Watch Event)
Kubelet → Container Runtime
    ↓
Running Pod
```

## Key Data Structures Passed Between Components

1. **resource.Info** (kubectl → API Server)
2. **apps.Deployment** (API Server → Deployment Controller)
3. **apps.ReplicaSet** (Deployment Controller → ReplicaSet Controller)
4. **v1.Pod** (ReplicaSet Controller → Scheduler → Kubelet)
5. **framework.QueuedPodInfo** (Scheduler internal)
6. **kubecontainer.Pod** (Kubelet internal)

## Controller Coordination Mechanisms

### 1. Deployment Controller → ReplicaSet
- Creates ReplicaSet with owner reference to Deployment
- Uses label selectors to manage ReplicaSets
- Rolling update strategy creates new ReplicaSet while scaling down old

### 2. ReplicaSet Controller → Pods
- Creates pods with owner reference to ReplicaSet
- Uses replica count to determine number of pods needed
- Label selector ensures pods belong to correct ReplicaSet

### 3. Scheduler → Kubelet
- Scheduler updates `pod.spec.nodeName` field
- Kubelet watches for pods assigned to its node
- No direct communication - coordination via API server

## Error Handling and Retry Logic

- **Controllers**: Use work queues with exponential backoff
- **API Server**: Returns appropriate HTTP status codes
- **Scheduler**: Failed scheduling triggers requeueing
- **Kubelet**: Retry failed container operations

This complete flow demonstrates Kubernetes' declarative model where each component watches for changes and reconciles state independently, creating a robust distributed system.