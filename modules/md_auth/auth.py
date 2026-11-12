"""
Utenti e autenticazione: password con bcrypt, token JWT firmati con una chiave
generata al primo avvio e salvata nella cartella dati.

Livelli (come iot-weight):
  1 sola lettura   vede dashboard, storico e report
  2 utente         + prende in carico gli allarmi
  3 amministratore + configurazione impianto, utenti di livello inferiore, simulatore
  4 super admin    + gestisce anche gli amministratori
"""
import logging
import os
import secrets
import time
from pathlib import Path

import bcrypt
import jwt

log = logging.getLogger("auth")

LEVEL_READONLY, LEVEL_USER, LEVEL_ADMIN, LEVEL_SUPER_ADMIN = 1, 2, 3, 4
LEVEL_NAMES = {1: "Sola lettura", 2: "Utente", 3: "Amministratore", 4: "Super admin"}
DEFAULT_TOKEN_HOURS = 24 * 30
MIN_PASSWORD_LENGTH = 6


class AuthError(Exception):
	pass


def hash_password(password):
	return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("ascii")


def check_password(password, password_hash):
	try:
		return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("ascii"))
	except ValueError:
		return False


def validate_password(password):
	if len(password or "") < MIN_PASSWORD_LENGTH:
		raise AuthError(f"La password deve avere almeno {MIN_PASSWORD_LENGTH} caratteri")


def load_secret_key(data_dir):
	"""Chiave di firma dei token: persistente, così i login sopravvivono ai riavvii."""
	path = Path(data_dir) / "secret.key"
	if path.exists():
		return path.read_text().strip()
	path.parent.mkdir(parents=True, exist_ok=True)
	key = secrets.token_urlsafe(48)
	path.write_text(key)
	try:
		os.chmod(path, 0o600)
	except OSError:
		pass
	return key


class Auth:
	def __init__(self, db, secret_key, token_hours=DEFAULT_TOKEN_HOURS):
		self.db = db
		self.secret_key = secret_key
		self.token_hours = token_hours

	def ensure_admin(self, password=None):
		"""Al primo avvio crea l'utente 'admin' (super admin) con obbligo di cambio password."""
		if self.db.count_users():
			return None
		password = password or "admin"
		self.db.create_user("admin", hash_password(password), LEVEL_SUPER_ADMIN, "Amministratore", must_change_password=True)
		log.warning("creato l'utente 'admin': cambia la password al primo accesso")
		return password

	def login(self, username, password):
		user = self.db.get_user(username=username.strip())
		if not user or not check_password(password, user["password_hash"]):
			raise AuthError("Nome utente o password errati")
		return self.issue_token(user), public_user(user)

	def issue_token(self, user):
		now = int(time.time())
		payload = {"sub": str(user["id"]), "iat": now, "exp": now + self.token_hours * 3600}
		return jwt.encode(payload, self.secret_key, algorithm="HS256")

	def user_from_token(self, token):
		try:
			payload = jwt.decode(token, self.secret_key, algorithms=["HS256"])
		except jwt.ExpiredSignatureError:
			raise AuthError("Sessione scaduta, accedi di nuovo")
		except jwt.PyJWTError:
			raise AuthError("Token non valido")
		user = self.db.get_user(user_id=int(payload["sub"]))
		if not user:
			raise AuthError("Utente non più esistente")
		return user

	def change_own_password(self, user, old_password, new_password):
		if not check_password(old_password, user["password_hash"]):
			raise AuthError("La password attuale non è corretta")
		validate_password(new_password)
		self.db.update_user(user["id"], password_hash=hash_password(new_password), must_change_password=0)

	# ---- gestione utenti (regole sui livelli) ------------------------
	@staticmethod
	def can_manage(actor, target_level):
		"""Si gestiscono solo utenti di livello inferiore; il super admin gestisce tutti."""
		return actor["level"] >= LEVEL_ADMIN and (target_level < actor["level"] or actor["level"] == LEVEL_SUPER_ADMIN)

	def create_user(self, actor, username, password, level, description=""):
		if level not in LEVEL_NAMES:
			raise AuthError("Livello non valido")
		if not self.can_manage(actor, level):
			raise AuthError(f"Non puoi creare utenti di livello {LEVEL_NAMES[level]}")
		if not username.strip():
			raise AuthError("Nome utente obbligatorio")
		if self.db.get_user(username=username.strip()):
			raise AuthError("Nome utente già esistente")
		validate_password(password)
		uid = self.db.create_user(username.strip(), hash_password(password), level, description, must_change_password=True)
		return public_user(self.db.get_user(user_id=uid))

	def update_user(self, actor, user_id, description=None, level=None, password=None):
		target = self.db.get_user(user_id=user_id)
		if not target:
			raise AuthError("Utente non trovato")
		if target["id"] == actor["id"] and level is not None and level != target["level"]:
			raise AuthError("Non puoi cambiare il tuo livello")
		if target["id"] != actor["id"] and not self.can_manage(actor, target["level"]):
			raise AuthError("Non puoi modificare un utente di livello pari o superiore al tuo")
		if level is not None and level != target["level"]:
			if level not in LEVEL_NAMES or not self.can_manage(actor, level):
				raise AuthError("Livello non assegnabile")
		fields = {"description": description, "level": level}
		if password:
			validate_password(password)
			fields.update(password_hash=hash_password(password), must_change_password=int(target["id"] != actor["id"]))
		self.db.update_user(user_id, **fields)
		return public_user(self.db.get_user(user_id=user_id))

	def delete_user(self, actor, user_id):
		target = self.db.get_user(user_id=user_id)
		if not target:
			raise AuthError("Utente non trovato")
		if target["id"] == actor["id"]:
			raise AuthError("Non puoi eliminare te stesso")
		if not self.can_manage(actor, target["level"]):
			raise AuthError("Non puoi eliminare un utente di livello pari o superiore al tuo")
		if target["level"] == LEVEL_SUPER_ADMIN and sum(u["level"] == LEVEL_SUPER_ADMIN for u in self.db.list_users()) <= 1:
			raise AuthError("Deve restare almeno un super admin")
		self.db.delete_user(user_id)


def public_user(user):
	return {"id": user["id"], "username": user["username"], "description": user["description"],
			"level": user["level"], "level_name": LEVEL_NAMES.get(user["level"], "?"),
			"must_change_password": bool(user["must_change_password"])}
