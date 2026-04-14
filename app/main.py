from fastapi import FastAPI, Depends, HTTPException, Query, Form, Request
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session
from sqlalchemy import func
from typing import Annotated
from datetime import date

# **ISPRAVENI IMPORTI**
from .db import SessionLocal, engine, Base
from . import models, schemas

# ---------------- DB SETUP ----------------
Base.metadata.create_all(bind=engine)

app = FastAPI(title="Zito Luks Backend")

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# ---------------- LOGIN ----------------
@app.get("/login", response_class=HTMLResponse)
def login_page():
    return """
    <html>
    <body>
    <h2>Login</h2>
    <form action="/login" method="post">
        Username: <input name="username"><br>
        Password: <input name="password" type="password"><br>
        <button type="submit">Login</button>
    </form>
    </body>
    </html>
    """

@app.post("/login", response_class=HTMLResponse)
def login(username: str = Form(...), password: str = Form(...), db: Session = Depends(get_db)):
    user = db.query(models.Driver).filter_by(username=username).first()
    if not user or user.password != password:
        return "<h3>Грешка login</h3>"
    return f"""
    <html>
    <body>
    <h3>Добредојде {user.name}</h3>
    <a href="/form?driver_id={user.id}">Внеси нарачка</a>
    </body>
    </html>
    """

# ---------------- FORM ----------------
@app.get("/form", response_class=HTMLResponse)
def form(driver_id: int, db: Session = Depends(get_db)):
    products = db.query(models.Product).all()
    markets = db.query(models.Market).all()
    html = f"""
    <html>
    <body>
    <h2>Нарачка</h2>
    <form action="/submit" method="post">
    <input type="hidden" name="driver_id" value="{driver_id}">
    <label>Маркет:</label>
    <select name="market_id">
        {''.join([f'<option value="{m.id}">{m.name}</option>' for m in markets])}
    </select>
    <br><br>
    {''.join([f'{p.name} ({p.price}) <input type="number" step="0.5" name="p_{p.code}" /><br>' for p in products])}
    <br>
    <button type="submit">Испрати</button>
    </form>
    </body>
    </html>
    """
    return html

@app.post("/submit", response_class=HTMLResponse)
async def submit(request: Request, db: Session = Depends(get_db)):
    form = await request.form()
    market_id = int(form.get("market_id"))
    driver_id = int(form.get("driver_id"))
    db_order = models.Order(market_id=market_id, driver_id=driver_id, date=date.today())
    db.add(db_order)
    db.commit()
    db.refresh(db_order)
    for key, value in form.items():
        if key.startswith("p_") and value:
            qty = float(value)
            if qty > 0:
                code = int(key.split("_")[1])
                db_item = models.OrderItem(order_id=db_order.id, product_code=code, qty=qty)
                db.add(db_item)
    db.commit()
    return "<h3>Успешно внесено!</h3><a href='/login'>Назад</a>"

# ---------------- PRODUCTS CRUD ----------------
@app.post("/products", response_model=schemas.ProductOut)
def create_product(product: schemas.ProductCreate, db: Session = Depends(get_db)):
    db_product = db.get(models.Product, product.code)
    if db_product:
        raise HTTPException(status_code=400, detail="Производ постои")
    db_product = models.Product(**product.dict())
    db.add(db_product)
    db.commit()
    db.refresh(db_product)
    return db_product

@app.get("/products", response_model=list[schemas.ProductOut])
def list_products(db: Session = Depends(get_db)):
    return db.query(models.Product).all()

@app.put("/products/{code}", response_model=schemas.ProductOut)
def update_product(code: int, product: schemas.ProductCreate, db: Session = Depends(get_db)):
    db_product = db.get(models.Product, code)
    if not db_product:
        raise HTTPException(status_code=404, detail="Производ не постои")
    for key, value in product.dict().items():
        setattr(db_product, key, value)
    db.commit()
    db.refresh(db_product)
    return db_product

@app.delete("/products/{code}", response_class=HTMLResponse)
def delete_product(code: int, db: Session = Depends(get_db)):
    db_product = db.get(models.Product, code)
    if not db_product:
        raise HTTPException(status_code=404, detail="Производ не постои")
    db.delete(db_product)
    db.commit()
    return f"<h3>Производот {db_product.name} е избришан</h3>"

# ---------------- MARKETS CRUD ----------------
@app.post("/markets", response_model=schemas.MarketOut)
def create_market(market: schemas.MarketCreate, db: Session = Depends(get_db)):
    existing = db.query(models.Market).filter_by(name=market.name).first()
    if existing:
        raise HTTPException(status_code=400, detail="Маркет постои")
    db_market = models.Market(**market.dict())
    db.add(db_market)
    db.commit()
    db.refresh(db_market)
    return db_market

@app.get("/markets", response_model=list[schemas.MarketOut])
def list_markets(db: Session = Depends(get_db)):
    return db.query(models.Market).all()

@app.put("/markets/{market_id}", response_model=schemas.MarketOut)
def update_market(market_id: int, market: schemas.MarketCreate, db: Session = Depends(get_db)):
    db_market = db.get(models.Market, market_id)
    if not db_market:
        raise HTTPException(status_code=404, detail="Маркет не постои")
    for key, value in market.dict().items():
        setattr(db_market, key, value)
    db.commit()
    db.refresh(db_market)
    return db_market

@app.delete("/markets/{market_id}", response_class=HTMLResponse)
def delete_market(market_id: int, db: Session = Depends(get_db)):
    db_market = db.get(models.Market, market_id)
    if not db_market:
        raise HTTPException(status_code=404, detail="Маркет не постои")
    db.delete(db_market)
    db.commit()
    return f"<h3>Маркетот {db_market.name} е избришан</h3>"

# ---------------- DRIVERS CRUD ----------------
@app.post("/drivers", response_model=schemas.DriverOut)
def create_driver(driver: schemas.DriverCreate, db: Session = Depends(get_db)):
    existing = db.query(models.Driver).filter_by(username=driver.username).first()
    if existing:
        raise HTTPException(status_code=400, detail="Username зафатен")
    db_driver = models.Driver(**driver.dict())
    db.add(db_driver)
    db.commit()
    db.refresh(db_driver)
    return db_driver

@app.get("/drivers", response_model=list[schemas.DriverOut])
def list_drivers(db: Session = Depends(get_db)):
    return db.query(models.Driver).all()

@app.put("/drivers/{driver_id}", response_model=schemas.DriverOut)
def update_driver(driver_id: int, driver: schemas.DriverCreate, db: Session = Depends(get_db)):
    db_driver = db.get(models.Driver, driver_id)
    if not db_driver:
        raise HTTPException(status_code=404, detail="Возач не постои")
    for key, value in driver.dict().items():
        setattr(db_driver, key, value)
    db.commit()
    db.refresh(db_driver)
    return db_driver

@app.delete("/drivers/{driver_id}", response_class=HTMLResponse)
def delete_driver(driver_id: int, db: Session = Depends(get_db)):
    db_driver = db.get(models.Driver, driver_id)
    if not db_driver:
        raise HTTPException(status_code=404, detail="Возач не постои")
    db.delete(db_driver)
    db.commit()
    return f"<h3>Возачот {db_driver.name} е избришан</h3>"

# ---------------- ORDERS CRUD ----------------
@app.get("/orders/{market_id}")
def orders_for_market(market_id: int, start: Annotated[date, Query()], end: Annotated[date, Query()], db: Session = Depends(get_db)):
    results = (
        db.query(
            models.OrderItem.product_code,
            models.Product.name,
            models.Product.price,
            func.sum(models.OrderItem.qty).label("total_qty")
        )
        .join(models.Order, models.OrderItem.order_id == models.Order.id)
        .join(models.Product, models.OrderItem.product_code == models.Product.code)
        .filter(models.Order.market_id == market_id)
        .filter(models.Order.date >= start)
        .filter(models.Order.date <= end)
        .group_by(models.OrderItem.product_code, models.Product.name, models.Product.price)
        .all()
    )
    return [{"product_code": r.product_code, "name": r.name, "price": r.price, "total_qty": r.total_qty, "total_value": float(r.price)*float(r.total_qty)} for r in results]

@app.get("/orders/detail/{order_id}")
def get_order(order_id: int, db: Session = Depends(get_db)):
    order = db.query(models.Order).get(order_id)
    if not order:
        raise HTTPException(status_code=404, detail="Нарачка не постои")
    items = db.query(models.OrderItem).filter_by(order_id=order.id).all()
    return {"order": order, "items": items}

@app.delete("/orders/{order_id}", response_class=HTMLResponse)
def delete_order(order_id: int, db: Session = Depends(get_db)):
    order = db.query(models.Order).get(order_id)
    if not order:
        raise HTTPException(status_code=404, detail="Нарачка не постои")
    db.query(models.OrderItem).filter_by(order_id=order.id).delete()
    db.delete(order)
    db.commit()
    return f"<h3>Нарачката {order.id} е избришана</h3>"

# ---------------- WEB CRUD за drivers и orders ----------------
# (кодот што ти го дадов последно – вметни го тука)

# ---------------- ROOT ----------------
@app.get("/")
def root():
    return {"message": "Zito Luks API is running"}