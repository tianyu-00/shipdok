-- Automatic image clean-up after each successful deployment is now ON for new apps. (It keeps the live version and the chosen number of earlier ones, the
-- same rule as the clean-up button, so a rollback stays possible.) Apps that already exist keep whatever they have: nothing is switched on behind anyone's back.
ALTER TABLE apps ALTER COLUMN auto_prune SET DEFAULT true;
