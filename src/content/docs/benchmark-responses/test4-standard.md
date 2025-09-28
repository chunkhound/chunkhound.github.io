---
title: "Test 4: Standard Claude Response"
description: "NetworkPolicy enforcement analysis with standard Claude Code"
---

# NetworkPolicy to iptables: Code Path Analysis

This document traces how Kubernetes NetworkPolicy objects transform into actual iptables rules on nodes, examining the complete code path from API to enforcement.

## Executive Summary

**Key Finding:** Kubernetes core does NOT implement NetworkPolicy enforcement. The API server provides only the NetworkPolicy resource definition, storage, and client tooling. Actual enforcement is delegated to CNI plugins and external network controllers.

## Architecture Overview

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   API Server    │    │  CNI Controller  │    │  Node Dataplane │
│                 │    │                  │    │                 │
│ NetworkPolicy   │───▶│ Watch/Reconcile  │───▶│ iptables/eBPF   │
│ CRUD + Storage  │    │ Transform Rules  │    │ Packet Filter   │
└─────────────────┘    └──────────────────┘    └─────────────────┘
```

## 1. NetworkPolicy Controller Architecture

### Core Kubernetes Components

Kubernetes provides the infrastructure but **no built-in enforcement**:

#### API and Storage Layer
- **Location**: `pkg/registry/networking/networkpolicy/`
- **Components**:
  - `storage/storage.go` - REST storage for NetworkPolicy CRUD operations
  - `strategy.go` - Validation and lifecycle management
- **Function**: Handles NetworkPolicy resource persistence in etcd

#### API Types and Validation
- **Location**: `pkg/apis/networking/`
- **Key Structures**:
```go
type NetworkPolicy struct {
    metav1.TypeMeta
    metav1.ObjectMeta
    Spec NetworkPolicySpec
}

type NetworkPolicySpec struct {
    PodSelector metav1.LabelSelector      // Target pods
    Ingress     []NetworkPolicyIngressRule // Ingress rules
    Egress      []NetworkPolicyEgressRule  // Egress rules
    PolicyTypes []PolicyType               // Policy types (Ingress/Egress)
}
```

#### Client Infrastructure
- **Location**: `staging/src/k8s.io/client-go/`
- **Components**:
  - **Informers**: Watch NetworkPolicy changes with event handlers
  - **Listers**: Provide cached read access for performance
  - **Typed Clients**: CRUD operations for NetworkPolicy resources

### Watch Pattern Implementation

External controllers (CNI plugins) use this pattern:

```go
// CNI controllers implement this pattern
informer := networkingInformers.NetworkPolicies()
informer.Informer().AddEventHandler(cache.ResourceEventHandlerFuncs{
    AddFunc:    controller.onNetworkPolicyAdd,
    UpdateFunc: controller.onNetworkPolicyUpdate,
    DeleteFunc: controller.onNetworkPolicyDelete,
})
```

## 2. CNI Plugin Integration

### Delegation Model

NetworkPolicy enforcement is **entirely delegated** to:
- **CNI plugins** (Calico, Cilium, Antrea, etc.)
- **External controllers** that watch NetworkPolicy resources
- **Node-level enforcement agents** (e.g., Calico Felix, Cilium Agent)

### CNI Controller Responsibilities

1. **Watch** NetworkPolicy objects via Kubernetes API
2. **Transform** policy specifications into dataplane rules
3. **Program** node networking stack (iptables, eBPF, etc.)
4. **Enforce** traffic policies at packet level

## 3. Kube-proxy's Role (or Lack Thereof)

### Key Finding: No NetworkPolicy Involvement

From `pkg/proxy/nftables/README.md:113`:

> "Implementations of pod networking, NetworkPolicy, service meshes, etc, may need to be aware of some slightly lower-level details of kube-proxy's implementation."

**kube-proxy is explicitly separate from NetworkPolicy enforcement.**

### kube-proxy's Actual Responsibilities

kube-proxy handles **service proxying only**:

1. **DNAT** - Rewrite service IPs to endpoint IPs
2. **SNAT** - Masquerade traffic for proper return routing
3. **Load balancer source ranges** - Filter traffic by source IP
4. **Service endpoint filtering** - Drop traffic to services without endpoints
5. **Service port rejection** - Reject traffic to undefined service ports

### Netfilter Hook Usage

kube-proxy uses these netfilter hooks:
- **prerouting**: DNAT for inbound service traffic
- **output**: DNAT for outbound service traffic
- **postrouting**: SNAT/masquerading
- **input/forward**: Service endpoint filtering

**NetworkPolicy enforcement happens in separate netfilter chains managed by CNI plugins.**

### Integration Guidelines

From the kube-proxy documentation:

- **Never modify** the `kube-proxy` nftables table
- **Create separate tables** for NetworkPolicy enforcement
- **Use appropriate priorities** to ensure correct rule ordering:
  - Service DNAT: `priority dstnat`
  - Service SNAT: `priority srcnat`
  - Filtering: `priority filter`

## 4. Node-Level Enforcement Mechanisms

### Calico Implementation

**Architecture**: Felix agent per node

**Transformation Process**:
1. **Watch** NetworkPolicy objects via Kubernetes API
2. **Calculate** effective policies for each workload endpoint
3. **Generate** iptables rules and ipsets
4. **Program** Linux netfilter with `cali-*` chains
5. **Apply** rules to packet flow

**iptables Structure**:
```
┌─────────────┐    ┌──────────────┐    ┌─────────────┐
│ cali-INPUT  │───▶│ cali-fw-*    │───▶│ cali-po-*   │
│ (hook)      │    │ (workload)   │    │ (policy)    │
└─────────────┘    └──────────────┘    └─────────────┘
```

**Rule Generation Example**:
```bash
# Generated for NetworkPolicy allowing port 80 from specific labels
-A cali-fw-cali1234567890 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A cali-fw-cali1234567890 -m set --match-set cali40s:label-app=frontend src -p tcp --dport 80 -j ACCEPT
-A cali-fw-cali1234567890 -j DROP
```

### Cilium Implementation

**Architecture**: Cilium agent per node

**eBPF Enforcement Process**:
1. **Watch** NetworkPolicy objects via Kubernetes API
2. **Compile** policies into eBPF bytecode
3. **Load** eBPF programs into kernel (TC hooks, XDP)
4. **Program** eBPF maps with policy rules
5. **Enforce** at packet level with native performance

**Data Structures**:
```
eBPF Maps:
├── policy_map (policy lookups)
├── endpoints_map (endpoint metadata)
├── ipcache_map (IP to identity mapping)
└── conntrack_map (connection state)
```

**Packet Processing**:
```
Packet → eBPF Program → Policy Maps → Verdict (ALLOW/DROP)
```

### Antrea Implementation

**Architecture**: Antrea agent per node

**Hybrid Approach**:
- **OpenFlow** rules in OVS (Open vSwitch) for L2/L3 forwarding
- **iptables** for specific policy enforcement scenarios
- **Kubernetes API** integration via controller pattern

## 5. Implementation Differences Between CNIs

### Performance Characteristics

| CNI     | Mechanism | Rule Processing | Performance      | Memory Usage |
|---------|-----------|-----------------|------------------|--------------|
| Calico  | iptables  | Sequential      | netfilter speed  | O(rules)     |
| Cilium  | eBPF      | Hash lookups    | Near-native      | O(policies)  |
| Antrea  | OVS/iptables | Flow tables   | Hardware accel.  | O(flows)     |

### Architectural Trade-offs

**Calico (iptables-based)**:
- ✅ Mature, well-understood semantics
- ✅ Standard Linux netfilter debugging tools
- ✅ Broad kernel compatibility
- ❌ Linear rule evaluation performance
- ❌ Rule explosion with complex policies

**Cilium (eBPF-based)**:
- ✅ High performance packet processing
- ✅ Rich observability with Hubble
- ✅ Advanced L7 policy support
- ❌ Newer technology, less debugging tooling
- ❌ Requires modern kernel versions

**Antrea (OVS-based)**:
- ✅ Hardware acceleration support
- ✅ Centralized flow management
- ✅ Layer 2 through Layer 7 support
- ❌ OVS complexity and dependencies
- ❌ Learning curve for OVS concepts

### Edge Case Handling: Loopback Traffic

From `test/e2e/network/netpol/network_policy.go:47`:

```go
// See https://github.com/kubernetes/kubernetes/issues/95879
// The semantics of the effect of network policies on loopback calls may be undefined
// Calico, Cilium, Antrea seem to do different things.
```

**Problem**: CNIs handle pod-to-self traffic inconsistently:
- **Undefined specification** for loopback policy semantics
- **Different packet paths** (lo interface vs veth pairs)
- **CNI-specific interpretations** of policy scope

**Solution**: Tests ignore loopback traffic (`ignoreLoopback = true`) to avoid CNI-specific failures.

## 6. Complete Data Flow Example

### Scenario: Pod A → Pod B with NetworkPolicy

1. **NetworkPolicy Creation**:
   ```yaml
   apiVersion: networking.k8s.io/v1
   kind: NetworkPolicy
   metadata:
     name: allow-frontend
   spec:
     podSelector:
       matchLabels:
         app: backend
     ingress:
     - from:
       - podSelector:
           matchLabels:
             app: frontend
       ports:
       - protocol: TCP
         port: 8080
   ```

2. **API Server Processing**:
   - Validates NetworkPolicy syntax
   - Stores in etcd
   - Sends events to watchers

3. **CNI Controller Response**:
   ```go
   // Pseudocode for CNI controller
   func (c *Controller) onNetworkPolicyAdd(policy *networkingv1.NetworkPolicy) {
       // Calculate affected workloads
       workloads := c.getAffectedWorkloads(policy.Spec.PodSelector)

       // Generate dataplane rules
       rules := c.transformPolicy(policy, workloads)

       // Program dataplane (iptables/eBPF/OVS)
       c.programDataplane(rules)
   }
   ```

4. **Dataplane Programming**:

   **Calico Example**:
   ```bash
   # Generated iptables rules
   -A cali-fw-cali1234567890 -m set --match-set cali40s:label-app=frontend src -p tcp --dport 8080 -j ACCEPT
   -A cali-fw-cali1234567890 -j DROP
   ```

   **Cilium Example**:
   ```c
   // eBPF program (simplified)
   if (policy_lookup(src_identity, dst_identity, protocol, port) == ALLOW) {
       return TC_ACT_OK;
   }
   return TC_ACT_SHOT;
   ```

5. **Packet Enforcement**:
   - Pod A sends packet to Pod B:8080
   - CNI dataplane evaluates policy
   - Packet allowed/dropped based on rules

## 7. Key Insights and Conclusions

### Design Philosophy

Kubernetes follows a **clear separation of concerns**:
- **API Server**: Resource management and storage
- **CNI Plugins**: Policy enforcement and networking
- **kube-proxy**: Service load balancing only

### Why This Architecture?

1. **Flexibility**: Multiple CNI implementations can coexist
2. **Specialization**: Network experts can optimize enforcement mechanisms
3. **Innovation**: eBPF, hardware acceleration, etc. can be adopted independently
4. **Modularity**: Networking concerns are isolated from core Kubernetes

### Critical Implementation Details

1. **No built-in enforcement**: Core Kubernetes only provides the API
2. **CNI responsibility**: All enforcement logic lives in external controllers
3. **kube-proxy separation**: Service proxying is orthogonal to NetworkPolicy
4. **Performance varies**: iptables vs eBPF vs OVS have different characteristics
5. **Edge cases exist**: Loopback traffic handling varies between implementations

### Operational Implications

- **Debugging**: Requires CNI-specific knowledge and tools
- **Performance**: Choose CNI based on policy complexity and scale requirements
- **Compatibility**: NetworkPolicy behavior may vary across CNI implementations
- **Monitoring**: Policy enforcement metrics come from CNI, not Kubernetes core

This architecture demonstrates Kubernetes' philosophy of providing APIs while delegating specialized implementations to focused components, enabling innovation while maintaining a stable core API surface.