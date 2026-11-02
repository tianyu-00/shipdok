-- Reclaiming: putting the data of a backup into ANOTHER app (its storage paths are added to that app when it lacks them), and attaching a kept volume to an app.
-- backups.volume_paths: the container paths a volume backup holds (so the dashboard can say which paths a reclaim would add); NULL for backups made before this.
ALTER TABLE backups ADD COLUMN volume_paths text[];
-- volume_restores: a reclaim is a restore into an app other than the backup's own (app_id is the app that receives it; backup_app_name is whose backup it was).
ALTER TABLE volume_restores
  ADD COLUMN reclaim         boolean NOT NULL DEFAULT false,
  ADD COLUMN backup_app_name text;
