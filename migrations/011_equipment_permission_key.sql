-- Rename the legacy equipment permission key without dropping a stored grant.
-- A tree grant is copied to equipment. If equipment already exists, a grant on
-- either key is kept. The tree key is then removed so it is no longer active.

BEGIN;

INSERT INTO role_permissions(role, permission, granted, created_at)
SELECT role,
       CASE WHEN permission = 'tree' THEN 'equipment' ELSE 'equipment.' || substr(permission, 6) END,
       granted,
       created_at
FROM role_permissions
WHERE permission = 'tree' OR permission LIKE 'tree.%'
ON CONFLICT (role, permission) DO UPDATE
SET granted = role_permissions.granted OR EXCLUDED.granted;

DELETE FROM role_permissions
WHERE permission = 'tree' OR permission LIKE 'tree.%';

COMMIT;
