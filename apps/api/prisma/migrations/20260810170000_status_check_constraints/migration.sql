-- Constrain status and method columns to their documented value sets.
--
-- These are Postgres CHECK constraints rather than Prisma enums on purpose:
-- two of the live values ('in-progress', 'no-show') contain hyphens, which are
-- not valid Prisma enum member names. Modelling them as enums would require
-- @map and change the JSON the API emits ('in_progress'), breaking the wire
-- contract in @smileflow/shared-types and every client that reads it. A CHECK
-- constraint gives the same guarantee — the database refuses an invalid value —
-- without changing the API surface.
--
-- The value sets here mirror the unions in packages/shared-types/src.

ALTER TABLE "Appointment"
  ADD CONSTRAINT "Appointment_status_check"
  CHECK (status IN ('scheduled', 'confirmed', 'in-progress', 'completed', 'cancelled', 'no-show'));

ALTER TABLE "Invoice"
  ADD CONSTRAINT "Invoice_status_check"
  CHECK (status IN ('unpaid', 'partial', 'paid', 'overdue', 'cancelled'));

ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_method_check"
  CHECK (method IN ('cash', 'credit_card', 'debit_card', 'insurance', 'bank_transfer'));

ALTER TABLE "TreatmentPlan"
  ADD CONSTRAINT "TreatmentPlan_status_check"
  CHECK (status IN ('planned', 'approved', 'in-progress', 'completed', 'cancelled'));

ALTER TABLE "TreatmentPlanItem"
  ADD CONSTRAINT "TreatmentPlanItem_status_check"
  CHECK (status IN ('planned', 'approved', 'completed'));
