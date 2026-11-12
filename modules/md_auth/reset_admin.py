"""
Reimposta la password dell'utente 'admin' (lo ricrea come super admin se non esiste).
Al prossimo accesso verrà chiesto di cambiarla. Storico e configurazione non vengono toccati.

Uso:  python -m modules.md_auth.reset_admin NUOVA_PASSWORD
In Docker:  docker compose exec iot-solar python -m modules.md_auth.reset_admin NUOVA_PASSWORD
"""
import sys

from modules.md_auth.auth import LEVEL_SUPER_ADMIN, AuthError, hash_password, validate_password
from modules.md_database.database import Database
from modules.md_runtime.settings import resolve_paths


def main(argv):
	if len(argv) != 2:
		print(__doc__)
		return 2
	password = argv[1]
	try:
		validate_password(password)
	except AuthError as e:
		print(e)
		return 1
	_, data_dir = resolve_paths()
	db = Database(str(data_dir / "iot-solar.db"))
	user = db.get_user(username="admin")
	if user:
		db.update_user(user["id"], password_hash=hash_password(password), level=LEVEL_SUPER_ADMIN, must_change_password=1)
	else:
		db.create_user("admin", hash_password(password), LEVEL_SUPER_ADMIN, "Amministratore", must_change_password=True)
	db.close()
	print("Password di 'admin' reimpostata: andrà cambiata al prossimo accesso.")
	return 0


if __name__ == "__main__":
	sys.exit(main(sys.argv))
