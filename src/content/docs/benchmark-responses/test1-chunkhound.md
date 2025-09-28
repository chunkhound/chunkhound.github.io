---
title: "Test 1: ChunkHound Response"
description: "kubectl apply flow analysis with ChunkHound semantic search"
---

# Complete Code Path: kubectl apply -f deployment.yaml to Running Pods

This document traces the complete journey from executing `kubectl apply -f deployment.yaml` to pods running on nodes, showing all major components, key functions, and data structures involved in the process.

## Overview

The flow involves six major components working together:
1. **kubectl client** - Parses YAML and sends API requests
2. **API Server** - Validates and stores Deployment objects
3. **Deployment Controller** - Creates ReplicaSets from Deployments
4. **ReplicaSet Controller** - Creates Pods from ReplicaSets
5. **Scheduler** - Assigns Pods to nodes
6. **kubelet** - Creates containers on assigned nodes

## 1. kubectl apply Command Implementation

### Entry Point
- **File**: `cmd/kubectl/kubectl.go:18`
- **Function**: `main()` → `cmd.NewDefaultKubectlCommand()`

### Core Apply Logic
- **File**: `staging/src/k8s.io/kubectl/pkg/cmd/apply/apply.go`
- **Key Functions**:
  - `NewCmdApply()` (line 198): Creates apply command with Run function
  - `ApplyOptions.Run()` (line 500): Main apply execution
    - Calls `o.GetObjects()` to parse YAML files into `resource.Info` objects
    - Iterates through each object calling `o.applyOneObject(info)`
  - `applyOneObject()` (line 555): Handles individual resource application
    - Creates `resource.Helper` with client and mapping information
    - For server-side apply: calls `helper.Patch()` with `ApplyPatchType`
    - Uses `staging/src/k8s.io/cli-runtime/pkg/resource/helper.go:241` Patch method
    - Makes REST call to API server: `m.RESTClient.Patch(pt).NamespaceIfScoped(...).Do()`

### Data Flow
```
YAML file → Unstructured objects → REST PATCH request → API server
```

## 2. API Server Request Handling for Deployments

### Registry Implementation
- **File**: `pkg/registry/apps/deployment/storage/storage.go`
- **Function**: `NewREST()` (line 93): Creates deployment REST storage with `generic.Store`

### Validation Strategy
- **File**: `pkg/registry/apps/deployment/strategy.go`
- **Key Functions**:
  - `PrepareForCreate()` (line 73): Sets initial status, generation = 1
  - `Validate()` (line 83): Calls `appsvalidation.ValidateDeployment()`
  - `ValidateUpdate()` (line 127): Validates deployment updates

### Processing Flow
1. HTTP PATCH request hits API server
2. Authentication/authorization checks
3. Admission controllers run
4. Validation via deployment strategy
5. Object stored in etcd
6. Event sent to watchers

## 3. Deployment Controller Creating ReplicaSets

### Controller Setup
- **File**: `cmd/kube-controller-manager/app/apps.go:120`
- **Function**: `newDeploymentController()`: Creates deployment controller with informers

### Core Controller Logic
- **File**: `pkg/controller/deployment/deployment_controller.go`
- **Key Functions**:
  - `NewDeploymentController()` (line 101): Sets up informers and event handlers
  - `syncHandler = dc.syncDeployment` (line 149): Main sync function

### ReplicaSet Creation Logic
- **File**: `pkg/controller/deployment/sync.go`
- **Key Functions**:
  - `getNewReplicaSet()` (line 200+): Core ReplicaSet creation logic
    - Generates ReplicaSet from deployment template
    - Calls `dc.client.AppsV1().ReplicaSets(d.Namespace).Create()` (line 231)
    - Handles hash collisions and retries

### Data Structures
- **Input**: `apps.Deployment` object
- **Output**: `apps.ReplicaSet` with:
  - Template from `deployment.Spec.Template`
  - `OwnerReference` pointing to deployment
  - Generated name with hash suffix

## 4. ReplicaSet Controller Creating Pods

### Controller Setup
- **File**: `cmd/kube-controller-manager/app/apps.go:93`
- **Function**: `newReplicaSetController()`: Creates ReplicaSet controller

### Core Logic
- **File**: `pkg/controller/replicaset/replica_set.go`
- **Key Functions**:
  - `syncReplicaSet()` (line 702): Main sync function
    - Calls `rsc.claimPods()` to find existing pods
    - Calls `rsc.manageReplicas()` to scale up/down
  - `manageReplicas()` (line 596): Pod creation logic
    - Calculates diff between desired and actual replicas
    - For scale up: calls `slowStartBatch()` with pod creation function
    - **Pod Creation**: `rsc.podControl.CreatePods()` (line 625)
      - Creates pods from `ReplicaSet.Spec.Template`
      - Sets `OwnerReference` to ReplicaSet
      - Calls API server to create pod objects

### Data Flow
```
ReplicaSet → Pod templates → API server pod creation
```

## 5. Scheduler Pod Assignment Logic

### Main Scheduler
- **File**: `pkg/scheduler/schedule_one.go`
- **Key Functions**:
  - `ScheduleOne()` (line 66): Main scheduling loop
    - Gets next pod from queue via `sched.NextPod()`
    - Calls `sched.schedulingCycle()` which calls `sched.SchedulePod()`
  - `schedulePod()` (line 430): Core scheduling algorithm
    - Updates node snapshot: `sched.Cache.UpdateSnapshot()`
    - **Filtering**: `sched.findNodesThatFitPod()` - runs predicates/filters
    - **Scoring**: `prioritizeNodes()` - scores feasible nodes
    - **Selection**: `selectHost()` - picks highest scoring node
    - Returns `ScheduleResult{SuggestedHost: host}`

### Algorithm Flow
1. **Pod predicates**: NodeResourcesFit, NodeAffinity, etc.
2. **Node scoring**: Resource balancing, affinity preferences
3. **Host selection**: Highest scoring node
4. **Binding creation**: Creates Binding object to assign pod to node

## 6. kubelet Pod Creation and Container Runtime

### kubelet Main Loop
- **File**: `pkg/kubelet/kubelet.go`
- **Key Components**:
  - `podWorkers` (line 1140+): Manages pod lifecycle state machine
    - States: syncing (syncPod), terminating, terminated
    - `UpdatePod()`: Notifies workers of pod changes (line 2958)

### Pod Sync Process
- **Function**: `SyncPod()` (around line 2050)
  1. **Pre-sync**: Create pod directories, ensure cgroups exist
  2. **Volume Setup**: `kl.volumeManager.WaitForAttachAndMount()`
  3. **Container Runtime**: `kl.containerRuntime.SyncPod()`

### Container Runtime Integration
- **File**: `pkg/kubelet/kuberuntime/kuberuntime_manager.go`
- **Key Functions**:
  - `SyncPod()`: Main container sync logic
  - `computePodActions()` (line 1007): Determines what containers need creation/restart
  - **Pod Sandbox**: Creates pod sandbox (network namespace)
  - **Container Creation**: Creates and starts individual containers
  - **CRI Interface**: Communicates with container runtime (Docker, containerd, CRI-O)

## Controller Coordination and Data Flow

### Objects Passed Between Components
1. **kubectl**: `resource.Info` containing `*apps.Deployment`
2. **API Server**: `apps.Deployment` → etcd storage
3. **Deployment Controller**: `apps.Deployment` → `apps.ReplicaSet`
4. **ReplicaSet Controller**: `apps.ReplicaSet` → `v1.Pod`
5. **Scheduler**: `v1.Pod` → `v1.Binding`
6. **kubelet**: `v1.Pod` → Container runtime calls

### Control Flow Coordination
- **Event-driven Architecture**: All controllers watch API server via informers
- **Work Queues**: Controllers use rate-limited queues for retries
- **Owner References**: Child objects point to parents for cleanup
- **Expectations**: Controllers track expected vs actual state changes

### State Transitions
```
kubectl apply → API Server → Deployment Controller → ReplicaSet Controller → Scheduler → kubelet → Container Runtime
      ↓              ↓                ↓                    ↓              ↓         ↓
  PATCH request → Deployment → ReplicaSet created → Pod created → Pod scheduled → Container running
```

## Summary of Key File Locations

| Component | File Path | Key Function | Line |
|-----------|-----------|--------------|------|
| kubectl apply | `staging/src/k8s.io/kubectl/pkg/cmd/apply/apply.go` | `ApplyOptions.Run()` | 500 |
| Deployment registry | `pkg/registry/apps/deployment/storage/storage.go` | `NewREST()` | 93 |
| Deployment controller | `pkg/controller/deployment/sync.go` | ReplicaSet creation | 231 |
| ReplicaSet controller | `pkg/controller/replicaset/replica_set.go` | Pod creation | 625 |
| Scheduler | `pkg/scheduler/schedule_one.go` | `schedulePod()` | 430 |
| kubelet | `pkg/kubelet/kubelet.go` | `SyncPod()` | 2050+ |

This complete trace shows how a single `kubectl apply` command triggers a cascade of controllers, each watching for changes and creating the next level of objects until pods are running on nodes with containers started by the container runtime.