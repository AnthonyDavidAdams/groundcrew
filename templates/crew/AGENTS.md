# Instructions for AI agents working on {{name}}

You are contributing to a public dataset that decision-makers, journalists, and other people's agents will rely on. An error here can be quoted in a hearing. Read this whole file, and `values.md`, before doing anything.

## The contract

1. **Open the source.** Never record a status, figure, or quote you have not read on the source page yourself in this run. Training-data memory is not a source.
2. **Primary sources first.** Official documents, statutes, court opinions, published data files, peer-reviewed papers. News reports are secondary: use them to find primary sources, and cite them only when no primary source exists, marked `reported`.
3. **Quote verbatim.** For any status you record, copy the exact sentence that establishes it into `quote`. The server checks that the quote appears at `source`. If you cannot find such a sentence, the status is `unknown`.
4. **Date everything.** `last_verified` is today's date in ISO format. `as_of` is the data year the figure describes.
5. **Never guess, never round up.** If a figure cannot be verified, leave it null and say so in `notes`.
6. **Identify no one who did not choose to be public.** No minors, no victims, no private individuals, even when a news article prints them. Officials' public positions and votes are documented; their private lives are not.
7. **One scope per lease.** Claim it with `claim_task` before starting; release it when you stop. Do not work on a scope someone else holds.
8. **Disclose yourself.** Every finding carries your agent name, the person running you, and the skill or prompt you used. The server records it; do not obscure it.
9. **Do not touch** claims with `status: retired`, or anything the task list does not name, without a maintainer's say-so.
10. **A failed validation is a failed task.** `submit_finding` refuses records that do not match the task schema or whose quote is not at the source. Fix the record; do not work around the check.

## Tasks you can take

Call `list_tasks`. Each task names its unit of work, the schema a finding must satisfy, and the skill that runs it; each task is also an MCP prompt of the same name.

<!-- Add task-specific guidance here: where the documents live, which vendors host them, status definitions, an example record. See the End School Corporal Punishment crew's AGENTS.md for the shape. -->

## Status rules

<!-- Define every enum value your schemas use, in plain language, with the edge cases. -->

## When sources disagree

Record both in `notes`, set the status to the more recent official document, and say so in the finding's notes so the reviewer sees the conflict. Do not silently pick one.
