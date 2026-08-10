-- Prevent double-booking a provider at the database level.
--
-- The application checks for conflicts before inserting, but a check followed
-- by an insert is not atomic: two simultaneous requests can both read a free
-- slot and both commit. An exclusion constraint makes the overlap impossible
-- regardless of how the application behaves, which also protects any future
-- caller (an automated agent, a bulk import) that skips the service layer.
--
-- btree_gist is required to combine an equality test on a scalar column with
-- an overlap test on a range in the same GiST index.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Cancelled appointments are excluded: a cancelled slot is free to rebook.
-- startTime/endTime are TIMESTAMP without time zone, so tsrange is the
-- matching range type. '[)' makes the range half-open, so an appointment
-- ending at 10:00 does not collide with one starting at 10:00.
ALTER TABLE "Appointment"
  ADD CONSTRAINT "Appointment_provider_no_overlap"
  EXCLUDE USING gist (
    "providerId" WITH =,
    tsrange("startTime", "endTime", '[)') WITH &&
  )
  WHERE (status <> 'cancelled');
