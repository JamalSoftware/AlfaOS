-- AlterTable
ALTER TABLE "service_order_material_usages" ADD COLUMN     "inventoryItemId" TEXT,
ADD COLUMN     "inventoryMovementId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "service_order_material_usages_inventoryMovementId_key" ON "service_order_material_usages"("inventoryMovementId");

-- AddForeignKey
ALTER TABLE "service_order_material_usages" ADD CONSTRAINT "service_order_material_usages_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_material_usages" ADD CONSTRAINT "service_order_material_usages_inventoryMovementId_fkey" FOREIGN KEY ("inventoryMovementId") REFERENCES "inventory_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

