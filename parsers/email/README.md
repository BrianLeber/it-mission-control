# Email parsers (planned)

This folder will hold the library of email parsers: one file per sender or product that
turns an alert email into **open** or **close** for a check. Examples are Veeam job
results, UPS notifications and vendor incident mail.

Parsers will use the same shape as connectors, so they can be contributed and reviewed the
same way:

```yaml
id: veeam-job-result
match:
  from: "veeam@*"
  subject: '^\[(?<result>Success|Warning|Failed)\] (?<job>.+?)( \(|$)'
check: veeam-{{job}}            # which check it reports to
key: "{{job}}"                  # correlation key: the follow-up email closes the same key
state:
  Failed: crit
  Warning: warn
  Success: ok                   # "ok" closes the open issue with this key
summary: "Job {{job}}: {{result}}"
```

Messages no rule matches go to the "System 1" classifier, a small fast model that maps a
message to a check, a state and a key. Anything below its confidence threshold lands in a
**needs review** queue. Confirming one offers to save a rule here. See section 5 of
[`docs/DESIGN.md`](../../docs/DESIGN.md).
