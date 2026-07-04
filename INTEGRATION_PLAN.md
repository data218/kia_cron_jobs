# INTEGRATION PLAN — Local Project → Master Project

> Created: 29 Jun 2026
> Status: Draft — Awaiting Approval

---

## ROLE
Senior Software Architect, Full Stack Engineer, and DevOps Engineer.

## OBJECTIVE
Integrate a currently working LOCAL project into the existing MASTER project.

The MASTER project is already connected to GitHub and automatically deployed on Vercel.

The LOCAL project is fully functional on localhost and must become part of the MASTER project without breaking any existing functionality.

---

## PHASE 1 — PROJECT ANALYSIS

Analyze BOTH projects completely.

Inspect and document:

- Framework (Next.js / React / Vite / etc.)
- Language (TypeScript / JavaScript)
- Folder structure
- Routing architecture
- Component architecture
- API architecture
- Database connections
- Authentication
- Middleware
- Services
- Utilities
- State management
- Environment variables
- Build configuration
- Dependencies
- Package manager
- Public assets
- Static files
- Shared components

Generate a complete compatibility report.

---

## PHASE 2 — CONFLICT DETECTION

Identify every possible conflict including:

- `package.json`
- `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock`
- `app/`, `src/`, `pages/`, `components/`, `lib/`, `hooks/`, `utils/`, `services/`, `middleware/`, `api/`, `public/`

Detect:

- Duplicate files
- Duplicate components
- Duplicate APIs
- Duplicate routes
- Dependency conflicts
- Version conflicts
- Environment conflicts
- Build conflicts
- Naming conflicts

Do NOT modify anything yet.

---

## PHASE 3 — INTEGRATION STRATEGY

Design the safest merge strategy.

The LOCAL project should become a module inside the MASTER project.

Example structure:

```
MASTER PROJECT
│
├── app/
├── components/
├── lib/
├── services/
├── modules/
│      └── LocalProject/
├── public/
└── package.json
```

Reuse existing shared code whenever possible. Avoid duplicate logic. Never overwrite working code.

---

## PHASE 4 — GITHUB STRATEGY

Use this Git workflow:

```
main
│
└── feature/local-project-integration
```

All work must happen inside `feature/local-project-integration`.

Never commit directly to `main`.

---

## PHASE 5 — IMPLEMENTATION RULES

Before editing ANY file:

1. **Explain WHY** it needs changing
2. **Show** file name, reason, impact
3. Only then modify it

Every modification must preserve existing functionality.

---

## PHASE 6 — CODE QUALITY

Reuse existing:

- Components
- Hooks
- Utilities
- Services
- API clients

Avoid duplication. Refactor only when safe. Never break production.

---

## PHASE 7 — DEPENDENCIES

Compare `package.json` files.

Generate a report:

- Existing packages
- New packages
- Duplicate packages
- Conflicting versions
- Unused packages

Merge dependencies safely.

---

## PHASE 8 — ENVIRONMENT VARIABLES

Merge all `.env` variables.

Report:

- Missing variables
- Duplicate variables
- Variables required for Vercel

Generate a new `.env.example`.

---

## PHASE 9 — ROUTING

Register the new module correctly.

Prevent route conflicts.

Maintain lazy loading if available.

Keep existing navigation intact.

---

## PHASE 10 — VALIDATION

Before any Git commit verify:

- [ ] Build succeeds
- [ ] No TypeScript errors
- [ ] No ESLint errors
- [ ] No missing imports
- [ ] No dependency conflicts
- [ ] No runtime errors
- [ ] No broken routes
- [ ] No broken APIs
- [ ] Existing application still works
- [ ] New module works

Only after all checks pass, continue.

---

## PHASE 11 — GIT WORKFLOW

```
git checkout -b feature/local-project-integration
git add .
git commit -m "Integrate local project into master application"
git push origin feature/local-project-integration
```

Do NOT merge into `main` automatically.

---

## PHASE 12 — OUTPUT FORMAT

For every phase produce:

1. **Analysis** — What was found
2. **Problems found** — Issues discovered
3. **Recommended solution** — How to fix
4. **Files affected** — Which files change
5. **Risk level** — Low / Medium / High
6. **Expected impact** — What changes for users
7. **Approval request** — Ask before proceeding

---

## IMPORTANT RULES

- DO NOT overwrite existing code.
- DO NOT delete existing functionality.
- DO NOT rename files unless absolutely necessary.
- DO NOT assume anything.
- Analyze before modifying.
- Keep the project production-ready.
- Preserve Git history whenever possible.
- Ensure the final project remains fully compatible with GitHub and Vercel automatic deployment.

Do NOT begin implementation until the analysis and integration plan have been completed and approved.
