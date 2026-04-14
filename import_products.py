import csv
from app.db import SessionLocal, Base, engine
from app import models

# креирај табелите
Base.metadata.create_all(bind=engine)

db = SessionLocal()

with open("products.csv", newline="", encoding="utf-8-sig") as f:
    reader = csv.DictReader(f)
    for row in reader:
        code = int(row[reader.fieldnames[0]].strip())   # првата колона, без грешки
        name = row[reader.fieldnames[1]].strip()
        price = float(row[reader.fieldnames[2]].strip())

        if db.get(models.Product, code):
            continue

        db_product = models.Product(code=code, name=name, price=price)
        db.add(db_product)

db.commit()
db.close()
print("Products imported successfully!")