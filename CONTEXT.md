# Village Browser Control

Village coordinates durable work while keeping interactive browser authority and sensitive site state on an owner's device.

## Language

**Job**:
A durable owner-scoped objective whose progress survives any one process or device.
_Avoid_: Task, run

**Browser Session**:
One site-scoped browsing continuity owned by a specific principal and local device.
_Avoid_: Browser, tab, VM

**Controller**:
The single actor currently entitled to mutate a Browser Session: Village, the owner, or nobody.
_Avoid_: Driver, operator

**Connection**:
The Browser Session's relationship to its authoritative coordinator: online, locally offline, or absent.
_Avoid_: Status

**Lease**:
A renewable grant of automated mutation authority for one Browser Session at one monotonically increasing epoch.
_Avoid_: Lock, session token

**Lease Epoch**:
The fencing number that permanently invalidates every automated command from an earlier grant.
_Avoid_: Version, generation

**Browser Action**:
One atomic, bounded mutation requested through Village's closed capability vocabulary.
_Avoid_: Command, tool call

**Action Phase**:
The durable evidence level for a Browser Action: accepted, dispatched, effect observed, or receipted.
_Avoid_: Progress

**Human Gate**:
A typed pause that only the owner can resolve, such as credentials, 2FA, consent, or an unknown challenge.
_Avoid_: Approval, error

**Observation**:
A bounded set of policy-defined facts derived from a hostile page, never raw page content.
_Avoid_: DOM snapshot, screenshot

**Checkpoint**:
A sanitized durable continuation boundary for a Job.
_Avoid_: Browser profile, snapshot

**Site Session**:
The local, site-specific authentication state retained inside a dedicated Browser Session profile.
_Avoid_: Village session, account

**Village Identity**:
The authenticated owner identity that scopes Jobs, devices, Browser Sessions, and handoffs across Village clients.
_Avoid_: Site Session, browser identity, model-provider account

**Takeover Marker**:
A local durable fact that blocks automation immediately while offline, before the coordinator can allocate a new Lease Epoch.
_Avoid_: Offline lease

**Verification Result**:
A versioned statement that a Site Session is authenticated, owner-confirmed, unauthenticated, or unknown.
_Avoid_: Login status
