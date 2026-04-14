# app/schemas.py
from pydantic import BaseModel, ConfigDict
from datetime import date

# ------------------- PRODUCTS -------------------
class ProductBase(BaseModel):
    code: int
    name: str
    price: float

class ProductCreate(ProductBase):
    pass

class ProductOut(ProductBase):
    model_config = ConfigDict(from_attributes=True)


# ------------------- MARKETS -------------------
class MarketBase(BaseModel):
    name: str
    line: str | None = None

class MarketCreate(MarketBase):
    pass

class MarketOut(MarketBase):
    id: int
    model_config = ConfigDict(from_attributes=True)


# ------------------- DRIVERS -------------------
class DriverBase(BaseModel):
    name: str
    username: str
    password: str

class DriverCreate(DriverBase):
    pass

class DriverOut(BaseModel):
    id: int
    name: str
    username: str
    model_config = ConfigDict(from_attributes=True)


# ------------------- ORDERS -------------------
class OrderItemIn(BaseModel):
    product_code: int
    qty: float


class OrderIn(BaseModel):
    market_id: int
    driver_id: int
    date: date
    items: list[OrderItemIn]


class OrderOut(BaseModel):
    id: int
    market_id: int
    driver_id: int
    date: date
    model_config = ConfigDict(from_attributes=True)