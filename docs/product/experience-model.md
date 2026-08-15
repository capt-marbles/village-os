# Village experience model

Status: accepted product direction, 2026-08-15

## Product promise

Village helps an owner turn recurring work into visible, reviewable Rituals. The
owner works with one accountable Steward. The Steward may gather bounded
specialists when a Ritual benefits from parallel work or distinct expertise,
but it remains responsible for the result.

> Your Steward carries out Rituals, shows its work, and learns how you want the
> work done.

Village is not an agent directory, a group chat between bots, or a visual
programming environment. The default experience remains one relationship, one
active decision, and one coherent result.

## Product language

| Term                  | Meaning                                                                  |
| --------------------- | ------------------------------------------------------------------------ |
| **Village**           | The owner-controlled working environment.                                |
| **Steward**           | The single accountable conversational front door.                        |
| **Ritual**            | A versioned, repeatable body of work with an expected result.            |
| **Villager**          | A temporary specialist gathered by the Steward for a bounded assignment. |
| **Run**               | One execution of a Ritual.                                               |
| **Review**            | The result, evidence, uncertainty, and owner feedback for a Run.         |
| **Learning proposal** | An evidence-backed suggestion to change a future Ritual.                 |
| **Revision**          | An approved, reversible change to a Ritual.                              |
| **Receipt**           | The human-readable and structured audit record for work performed.       |

Internal implementation may continue to use precise terms such as Job, step,
effect, lease, checkpoint, and artifact. Product language must not weaken those
authority or reliability boundaries.

## The core loop

```text
Shape Ritual
  -> Run
  -> Present result and evidence
  -> Review
  -> Propose learning
  -> Owner approves, edits, or rejects
  -> Versioned revision
  -> Evaluate the next Run
```

The owner can pause, edit, test, inspect, or retire a Ritual at any time. A
Ritual may be invoked manually, scheduled, or triggered by an event; recurring
does not mean cron-only.

Learning is governed improvement, not unrestricted self-modification. Village
may observe outcomes and propose changes, but it must not silently rewrite a
Ritual, expand its authority, change security policy, or promote a new reusable
procedure.

## Steward and Villagers

The user experience is one dependable teammate even when execution involves
several specialists.

```text
Owner
  -> Steward
      -> Research specialist
      -> Browser operator
      -> Reviewer
  -> One result, one explanation, one Receipt
```

Villagers are execution-scoped rather than a permanent roster the owner must
administer. Each assignment must have:

- a functional role and bounded deliverable;
- explicit input facts and artifact references;
- an allowed capability, site, budget, and time boundary;
- completion and failure criteria;
- a durable owner and audit identity.

The Steward owns synthesis, escalation, and communication with the owner.
Villagers do not silently create delegation trees, broaden permissions, alter
Rituals, or present competing conversations to the owner.

The interface may expose delegation when it makes progress or provenance easier
to understand. It should not display agent activity merely as theatre.

## Conversational decision surfaces

Chat is the narrative layer. Decision surfaces are the control layer. The
browser pane is the action and evidence layer. Receipts are the accountability
layer.

Village chooses the smallest trusted interface appropriate to the decision:

- **Choose or compare:** recommendation cards with material trade-offs.
- **Prioritize:** an ordered list or constrained priority board.
- **Allocate:** bounded controls for time, budget, risk, or attention.
- **Schedule:** a recurrence editor with a live plain-language summary.
- **Approve:** a before-and-after effect preview with scope and reversibility.
- **Shape a Ritual:** a readable trigger, step, gate, result, and review flow.
- **Recover:** safe retry, redirect, takeover, skip-incomplete, or cancel.

The model emits a versioned semantic intent, never arbitrary JSX, HTML,
component names, scripts, or callbacks. A trusted Village renderer maps that
intent to source-owned UI components, validates the answer, and records a typed
decision event.

Only one unresolved consequential decision should demand attention at a time.
Completed surfaces collapse into concise decision summaries. Complex surfaces
may expand into the side pane or a mobile drawer without losing their place in
the conversation.

### Ritual Builder v1

The first Ritual Builder is an interaction with the Steward, not a blank form
or node canvas. The owner describes the desired recurring outcome in chat. The
Steward asks one consequential question at a time and maintains a live Ritual
draft in a contextual side pane.

```text
Conversation with Steward        Ritual draft side pane
-------------------------        ----------------------
Describe the outcome        ->   Purpose
Answer focused questions    ->   Trigger and inputs
Ask for a change            ->   Steps and Villagers
Review the proposal         ->   Human gates and permissions
Approve                     ->   Expected result and review policy
```

The side pane is a legible preview of the emerging agreement, not a second
conversation. It remains synchronized with chat and shows:

- the Ritual's purpose and expected result;
- how it starts: manual, scheduled, or event-triggered;
- the proposed steps and any bounded Villager assignments;
- required inputs, tools, sites, and budgets;
- human approval and takeover points;
- what counts as complete and what produces a Receipt;
- how feedback may produce a future learning proposal.

The owner may request changes conversationally or edit supported fields
directly in the side pane. Either path updates the same versioned draft and the
Steward acknowledges the material change in chat. Direct edits must not become
a separate configuration authority.

The draft is inert until the owner explicitly approves it. Approval binds the
exact displayed draft revision and creates Ritual revision 1; a stale or
partially updated draft cannot be approved. Saving the Ritual does not silently
start a Run. The Steward separately offers a safe first test Run and explains
any effects or approvals it will require.

On a narrow screen, the same draft opens as a drawer and preserves conversation
position, draft revision, and unresolved question. The desktop side pane and
mobile drawer are two presentations of one draft, not independent state.

The v1 builder deliberately excludes a free-form graph editor, arbitrary
component generation, simultaneous editing by multiple agents, nested
delegation trees, and autonomous learning changes. Those capabilities require
evidence from real Rituals before admission.

## Learning and audit lineage

Every change to future behavior must retain its evidence and approval path:

```text
Ritual revision
  -> Run
  -> actions, specialists, and approvals
  -> result and evidence
  -> owner feedback
  -> learning proposal
  -> approved revision
  -> subsequent evaluation
```

Village records semantic events rather than relying on an unreadable stream of
internal logs. A Receipt should eventually answer:

- What was requested and what counted as done?
- Which Steward or Villager performed each step?
- Which sources, artifacts, and observations support the result?
- Which external effects occurred, and under whose approval?
- What remained uncertain or incomplete?
- What feedback changed later Runs, when, and why?
- Can the owner restore an earlier reviewed revision?

## Scope guardrails

### Establish first

- one Steward that can complete a useful Ritual reliably;
- visible progress, focused human gates, and safe takeover;
- a coherent result and Receipt;
- explicit feedback and a reviewable learning proposal;
- a versioned revision that can be evaluated and rolled back.

### Introduce only when a Ritual proves the need

- multiple Villagers in one Run;
- parallel assignments and handoffs;
- reusable specialist templates;
- cross-Ritual learning;
- team administration or shared organizational roles.

### Do not introduce as product defaults

- an agent marketplace or permanent agent army;
- multi-agent group-chat theatre;
- silent self-editing prompts, skills, policies, or permissions;
- dashboards whose primary purpose is configuring the system;
- arbitrary model-generated interfaces;
- a second workflow, scheduling, memory, or audit authority beside the Village
  Job ledger.

Every new surface must remove more cognitive work than it adds. Every Villager
must make a concrete Ritual easier, faster, safer, or more trustworthy.
