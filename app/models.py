# app/models.py
from sqlalchemy import Column, Integer, String, Float
from .db import Base

class Product(Base):
    __tablename__ = "products"

    code = Column(Integer, primary_key=True, index=True)  # пример: 814
    name = Column(String, nullable=False)                 # "Bel Rolovan leb"
    price = Column(Float, nullable=False)                 # 30, 94, ...

class Market(Base):
    __tablename__ = "markets"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    name = Column(String, unique=True, nullable=False)    # "Tinex 5"
    line = Column(String, nullable=True)                  # "Линија 1" итн.

class Driver(Base):
    __tablename__ = "drivers"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    name = Column(String, nullable=False)                 # "Goran"
    username = Column(String, unique=True, nullable=False)
    password = Column(String, nullable=False)             # за сега plain, подоцна hash

from sqlalchemy import Column, Integer, String, Float, ForeignKey, Date
from sqlalchemy.orm import relationship

class Order(Base):
    __tablename__ = "orders"

    id = Column(Integer, primary_key=True, index=True)
    market_id = Column(Integer, ForeignKey("markets.id"), nullable=False)
    driver_id = Column(Integer, ForeignKey("drivers.id"), nullable=False)
    date = Column(Date, nullable=False)

    items = relationship("OrderItem", back_populates="order")

class OrderItem(Base):
    __tablename__ = "order_items"

    id = Column(Integer, primary_key=True, index=True)
    order_id = Column(Integer, ForeignKey("orders.id"), nullable=False)
    product_code = Column(Integer, ForeignKey("products.code"), nullable=False)
    qty = Column(Float, nullable=False)

    order = relationship("Order", back_populates="items")