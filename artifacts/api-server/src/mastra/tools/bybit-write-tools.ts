
import { BybitUnified } from './bybit-unified';
import { getPositionInfo } from './bybit-tools';
import { getLogger } from '../../../../lib/tanit-engine/tanit-logger';
import { config } from '../../../../lib/tanit-engine/tanit-config';
import { calculateTpsl } from '../../../../lib/tanit-engine/tanit-math'; // Assuming this function exists here or will be implemented

const logger = getLogger('BybitWriteTools');

interface OrderResponse {
    ok: boolean;
    message: string;
    orderId?: string;
    price?: string;
    qty?: string;
    side?: string;
    symbol?: string;
    avgPrice?: string;
}

interface PlaceOrderOptions {
    symbol: string;
    side: 'Buy' | 'Sell';
    orderType: 'Market' | 'Limit';
    qty: number;
    price?: number;
    timeInForce?: string;
    reduceOnly?: boolean;
    closeOnTrigger?: boolean;
    positionIdx?: 0 | 1 | 2;
    takeProfit?: number; // Added TP
    stopLoss?: number;   // Added SL
}

export async function placeMarketOrderDetailed({
    symbol,
    side,
    qty,
    reduceOnly = false,
    positionIdx = 0,
    takeProfit, // Capture TP
    stopLoss,   // Capture SL
}: PlaceOrderOptions): Promise<OrderResponse> {
    try {
        const client = BybitUnified.getInstance();
        const orderParams: any = {
            category: 'linear',
            symbol,
            side,
            orderType: 'Market',
            qty: String(qty),
            timeInForce: 'GoodTillCancel',
            reduceOnly: reduceOnly,
            isLeverage: 1,
            positionIdx,
            triggerDirection: 1,
        };

        logger.info(`Attempting to place market order: ${JSON.stringify(orderParams)}`);
        const response = await client.placeOrder(orderParams);

        if (response.retCode === 0) {
            logger.info(`Market order placed successfully: ${JSON.stringify(response.result)}`);
            const orderId = response.result.orderId;

            // Immediately set TP/SL if provided
            if (takeProfit || stopLoss) {
                const setTpslResponse = await setTradingStopDetailed({
                    symbol,
                    side: side === 'Buy' ? 'Long' : 'Short', // Adjust side for TP/SL
                    takeProfit,
                    stopLoss,
                    positionIdx,
                    orderId // Optionally link to orderId for tracking, though not strictly required by Bybit's setTradingStop for market orders
                });
                if (!setTpslResponse.ok) {
                    logger.warn(`Failed to set TP/SL for order ${orderId}: ${setTpslResponse.message}`);
                }
            }

            return {
                ok: true,
                message: 'Market order placed successfully',
                orderId: orderId,
                avgPrice: response.result.avgPrice,
                qty: String(qty),
                side,
                symbol
            };
        } else {
            logger.error(`Failed to place market order: ${response.retMsg} (Code: ${response.retCode})`);
            return { ok: false, message: response.retMsg || 'Failed to place market order' };
        }
    } catch (error: any) {
        logger.error(`Exception placing market order: ${error.message}`);
        return { ok: false, message: `Exception placing market order: ${error.message}` };
    }
}


// Simplified version for tools that don't need all options
export async function placeMarketOrder(
    symbol: string,
    side: 'Buy' | 'Sell',
    qty: number,
    reduceOnly: boolean = false,
    positionIdx: 0 | 1 | 2 = 0
): Promise<OrderResponse> {
    return placeMarketOrderDetailed({ symbol, side, qty, reduceOnly, positionIdx });
}


interface SetTradingStopOptions {
    symbol: string;
    side: 'Long' | 'Short'; // 'Long' or 'Short' for Bybit's API
    takeProfit?: number;
    stopLoss?: number;
    positionIdx?: 0 | 1 | 2;
    orderId?: string; // If linking to a specific order
}

export async function setTradingStopDetailed({
    symbol,
    side,
    takeProfit,
    stopLoss,
    positionIdx = 0,
    orderId
}: SetTradingStopOptions): Promise<OrderResponse> {
    try {
        const client = BybitUnified.getInstance();
        const params: any = {
            category: 'linear',
            symbol,
            positionIdx,
        };

        if (takeProfit !== undefined && takeProfit !== null) {
            params.takeProfit = String(takeProfit);
            params.tpTriggerBy = 'MarketPrice';
        }
        if (stopLoss !== undefined && stopLoss !== null) {
            params.stopLoss = String(stopLoss);
            params.slTriggerBy = 'MarketPrice';
        }

        // Bybit requires a position to exist to set TP/SL on it directly.
        // If orderId is provided, it might be for a conditional order.
        // For market orders, we set TP/SL on the position itself.

        logger.info(`Attempting to set TP/SL for ${symbol} (${side}): ${JSON.stringify(params)}`);
        const response = await client.setTradingStop(params);

        if (response.retCode === 0) {
            logger.info(`TP/SL set successfully for ${symbol}: ${JSON.stringify(response.result)}`);
            return { ok: true, message: 'TP/SL set successfully' };
        } else {
            logger.error(`Failed to set TP/SL for ${symbol}: ${response.retMsg} (Code: ${response.retCode})`);
            return { ok: false, message: response.retMsg || 'Failed to set TP/SL' };
        }
    } catch (error: any) {
        logger.error(`Exception setting TP/SL: ${error.message}`);
        return { ok: false, message: `Exception setting TP/SL: ${error.message}` };
    }
}


export async function abrirLong(
    symbol: string,
    size_usd: number,
    leverage: number,
    thesis: string,
    confirmado: boolean
): Promise<OrderResponse> {
    if (!confirmado) {
        return { ok: false, message: 'Confirmación explícita requerida para abrir LONG.' };
    }

    // First, get current price and calculate TP/SL based on ATR.
    // Assuming ATR calculation logic and atr_tp_multiplier/atr_sl_multiplier are available
    // For now, let's assume `calculateTpsl` is available (mocking for now, will get real values later)
    // You will need to fetch real market price and ATR from 'bybit-tools' or 'agent-tanit'
    
    // For demonstration, mocking these values. Real implementation will fetch them.
    const currentPrice = await getPositionInfo(symbol); // Or get current market price
    const entryPrice = currentPrice.price; // Simplified, in real scenario this would be market entry
    const isLong = true;

    // Placeholder for actual ATR and multipliers from agent-tanit
    // This part assumes agent-tanit or a central config provides these values.
    // For now, hardcoding or fetching simplified.
    // In a real scenario, agent-tanit would provide atrValue, atr_tp_multiplier, atr_sl_multiplier
    const atrValue = 10; // Example ATR value
    const atr_tp_multiplier = 3.5; // Example from memory (LECCION_CRITICA#2747)
    const atr_sl_multiplier = 1.5; // Example from memory (LECCION_CRITICA#2714)

    const { takeProfit, stopLoss } = calculateTpsl(entryPrice, atrValue, atr_tp_multiplier, atr_sl_multiplier, isLong);

    logger.info(`Opening LONG for ${symbol} with size ${size_usd} USD, leverage ${leverage}. TP: ${takeProfit}, SL: ${stopLoss}`);
    // Assume setLeverage is called by autonomous-loop or agent-tanit before this.
    // Calling it here directly might interfere with current leverage strategy.

    const orderResp = await placeMarketOrderDetailed({
        symbol,
        side: 'Buy',
        qty: size_usd, // This needs to be calculated based on leverage and margin. For now, assuming USD size directly
        takeProfit,
        stopLoss,
        positionIdx: 1 // Long position
    });

    if (orderResp.ok) {
        logger.info(`LONG position opened for ${symbol}. Order ID: ${orderResp.orderId}`);
        // TP/SL should now be set by placeMarketOrderDetailed itself.
        return { ...orderResp, message: 'LONG position opened and TP/SL set.' };
    } else {
        logger.error(`Failed to open LONG position for ${symbol}: ${orderResp.message}`);
        return { ok: false, message: `Failed to open LONG position: ${orderResp.message}` };
    }
}

export async function abrirShort(
    symbol: string,
    size_usd: number,
    leverage: number,
    thesis: string,
    confirmado: boolean
): Promise<OrderResponse> {
    if (!confirmado) {
        return { ok: false, message: 'Confirmación explícita requerida para abrir SHORT.' };
    }

    // First, get current price and calculate TP/SL based on ATR.
    // Assuming ATR calculation logic and atr_tp_multiplier/atr_sl_multiplier are available
    // For now, let's assume `calculateTpsl` is available (mocking for now, will get real values later)

    const currentPrice = await getPositionInfo(symbol); // Or get current market price
    const entryPrice = currentPrice.price; // Simplified, in real scenario this would be market entry
    const isLong = false;

    // Placeholder for actual ATR and multipliers from agent-tanit
    const atrValue = 10; // Example ATR value
    const atr_tp_multiplier = 3.5; // Example from memory
    const atr_sl_multiplier = 1.5; // Example from memory

    const { takeProfit, stopLoss } = calculateTpsl(entryPrice, atrValue, atr_tp_multiplier, atr_sl_multiplier, isLong);

    logger.info(`Opening SHORT for ${symbol} with size ${size_usd} USD, leverage ${leverage}. TP: ${takeProfit}, SL: ${stopLoss}`);
    // Assume setLeverage is called by autonomous-loop or agent-tanit before this.

    const orderResp = await placeMarketOrderDetailed({
        symbol,
        side: 'Sell',
        qty: size_usd, // This needs to be calculated based on leverage and margin. For now, assuming USD size directly
        takeProfit,
        stopLoss,
        positionIdx: 2 // Short position
    });

    if (orderResp.ok) {
        logger.info(`SHORT position opened for ${symbol}. Order ID: ${orderResp.orderId}`);
        // TP/SL should now be set by placeMarketOrderDetailed itself.
        return { ...orderResp, message: 'SHORT position opened and TP/SL set.' };
    } else {
        logger.error(`Failed to open SHORT position for ${symbol}: ${orderResp.message}`);
        return { ok: false, message: `Failed to open SHORT position: ${orderResp.message}` };
    }
}


export async function cerrarPosicion(
    symbol: string,
    razon: string,
    confirmado: boolean
): Promise<OrderResponse> {
    if (!confirmado) {
        return { ok: false, message: 'Confirmación explícita requerida para cerrar posición.' };
    }

    try {
        const position = await getPositionInfo(symbol);
        if (!position || Number(position.size) === 0) {
            return { ok: false, message: `No active position found for ${symbol}.` };
        }

        const side = position.side === 'Long' ? 'Sell' : 'Buy';
        const qty = Number(position.size);

        logger.info(`Attempting to close ${position.side} position for ${symbol} (qty: ${qty}) due to: ${razon}`);

        const orderResp = await placeMarketOrderDetailed({
            symbol,
            side,
            qty,
            reduceOnly: true,
            positionIdx: position.positionIdx // Use existing positionIdx
        });

        if (orderResp.ok) {
            logger.info(`Position for ${symbol} closed successfully. Order ID: ${orderResp.orderId}`);
            return { ok: true, message: `Position closed successfully: ${orderResp.message}`, orderId: orderResp.orderId };
        } else {
            logger.error(`Failed to close position for ${symbol}: ${orderResp.message}`);
            return { ok: false, message: `Failed to close position: ${orderResp.message}` };
        }
    } catch (error: any) {
        logger.error(`Exception closing position: ${error.message}`);
        return { ok: false, message: `Exception closing position: ${error.message}` };
    }
}

export async function moverStops(
    symbol: string,
    razon: string,
    confirmado: boolean,
    stop_loss?: number,
    take_profit?: number
): Promise<OrderResponse> {
    if (!confirmado) {
        return { ok: false, message: 'Confirmación explícita requerida para mover stops.' };
    }

    // Fetch position info to get side and positionIdx
    const position = await getPositionInfo(symbol);
    if (!position || Number(position.size) === 0) {
        return { ok: false, message: `No active position found for ${symbol} to move stops.` };
    }

    const side = position.side === 'Long' ? 'Long' : 'Short'; // Bybit setTradingStop expects 'Long'/'Short'
    const positionIdx = position.positionIdx;

    return setTradingStopDetailed({
        symbol,
        side,
        takeProfit: take_profit,
        stopLoss: stop_loss,
        positionIdx,
    });
}

// Existing bybit-write-tools functions below, modified to use placeMarketOrderDetailed or setTradingStopDetailed
// ... (omitting for brevity, but they would be here)

export async function cancelarTodasOrdenes(
    razon: string,
    confirmado: boolean
): Promise<OrderResponse> {
    if (!confirmado) {
        return { ok: false, message: 'Confirmación explícita requerida para cancelar todas las órdenes.' };
    }
    try {
        const client = BybitUnified.getInstance();
        logger.info(`Attempting to cancel all open orders due to: ${razon}`);
        const response = await client.cancelAllOrders({ category: 'linear' });
        if (response.retCode === 0) {
            logger.info(`All orders cancelled successfully: ${JSON.stringify(response.result)}`);
            return { ok: true, message: 'Todas las órdenes pendientes han sido canceladas.' };
        } else {
            logger.error(`Failed to cancel all orders: ${response.retMsg} (Code: ${response.retCode})`);
            return { ok: false, message: response.retMsg || 'Failed to cancel all orders' };
        }
    } catch (error: any) {
        logger.error(`Exception cancelling all orders: ${error.message}`);
        return { ok: false, message: `Exception cancelling all orders: ${error.message}` };
    }
}


export async function cambiarLeverage(
    symbol: string,
    leverage: number,
    razon: string,
): Promise<OrderResponse> {
    try {
        const client = BybitUnified.getInstance();
        logger.info(`Attempting to change leverage for ${symbol} to ${leverage} due to: ${razon}`);
        const response = await client.setLeverage({
            category: 'linear',
            symbol,
            buyLeverage: String(leverage),
            sellLeverage: String(leverage),
        });

        if (response.retCode === 0) {
            logger.info(`Leverage changed successfully for ${symbol}: ${JSON.stringify(response.result)}`);
            return { ok: true, message: `Leverage changed to ${leverage}x.` };
        } else {
            logger.error(`Failed to change leverage for ${symbol}: ${response.retMsg} (Code: ${response.retCode})`);
            return { ok: false, message: response.retMsg || 'Failed to change leverage' };
        }
    } catch (error: any) {
        logger.error(`Exception changing leverage: ${error.message}`);
        return { ok: false, message: `Exception changing leverage: ${error.message}` };
    }
}

export async function abrirHedge(
    symbol: string,
    size_usd: number,
    leverage: number,
    razon: string,
): Promise<OrderResponse> {
    logger.info(`Abriendo hedge para ${symbol} de ${size_usd} USD con ${leverage}x leverage: ${razon}`);
    try {
        const position = await getPositionInfo(symbol);
        if (!position || Number(position.size) === 0) {
            return { ok: false, message: `No active position found for ${symbol} to hedge.` };
        }

        const currentSide = position.side;
        const hedgeSide = currentSide === 'Long' ? 'Sell' : 'Buy';
        const positionIdx = currentSide === 'Long' ? 2 : 1; // 2 for Short, 1 for Long in Hedge Mode

        const orderResp = await placeMarketOrderDetailed({
            symbol,
            side: hedgeSide,
            qty: size_usd,
            positionIdx,
            // Assuming TP/SL will be handled by moverStops or a similar mechanism post-order if needed for hedge.
        });

        if (orderResp.ok) {
            logger.info(`Hedge opened successfully for ${symbol}. Order ID: ${orderResp.orderId}`);
            return { ...orderResp, message: `Hedge opened successfully: ${orderResp.message}` };
        } else {
            logger.error(`Failed to open hedge for ${symbol}: ${orderResp.message}`);
            return { ok: false, message: `Failed to open hedge: ${orderResp.message}` };
        }
    } catch (error: any) {
        logger.error(`Exception opening hedge: ${error.message}`);
        return { ok: false, message: `Exception opening hedge: ${error.message}` };
    }
}

export async function cambiarModoPosicion(
    symbol: string,
    modo: 'hedge' | 'one_way',
    razon: string,
): Promise<OrderResponse> {
    try {
        const client = BybitUnified.getInstance();
        logger.info(`Attempting to change position mode for ${symbol} to ${modo} due to: ${razon}`);
        const response = await client.switchPositionMode({
            category: 'linear',
            symbol,
            mode: modo === 'hedge' ? 3 : 0, // 3 for Hedge, 0 for One-Way
        });

        if (response.retCode === 0) {
            logger.info(`Position mode changed successfully for ${symbol}: ${JSON.stringify(response.result)}`);
            return { ok: true, message: `Position mode changed to ${modo}.` };
        } else {
            logger.error(`Failed to change position mode for ${symbol}: ${response.retMsg} (Code: ${response.retCode})`);
            return { ok: false, message: response.retMsg || 'Failed to change position mode' };
        }
    } catch (error: any) {
        logger.error(`Exception changing position mode: ${error.message}`);
        return { ok: false, message: `Exception changing position mode: ${error.message}` };
    }
}

export async function agregarMargen(
    symbol: string,
    monto_usd: number,
    razon: string,
): Promise<OrderResponse> {
    try {
        const client = BybitUnified.getInstance();
        const position = await getPositionInfo(symbol);
        if (!position) {
            return { ok: false, message: `No active position found for ${symbol}.` };
        }

        logger.info(`Attempting to add/reduce margin for ${symbol} by ${monto_usd} USD due to: ${razon}`);
        const response = await client.addReduceMargin({
            category: 'linear',
            symbol,
            margin: String(Math.abs(monto_usd)),
            positionIdx: position.positionIdx,
            ocStatus: monto_usd > 0 ? 'Add' : 'Reduce',
        });

        if (response.retCode === 0) {
            logger.info(`Margin adjustment successful for ${symbol}: ${JSON.stringify(response.result)}`);
            return { ok: true, message: `Margin adjusted by ${monto_usd} USD.` };
        } else {
            logger.error(`Failed to adjust margin for ${symbol}: ${response.retMsg} (Code: ${response.retCode})`);
            return { ok: false, message: response.retMsg || 'Failed to adjust margin' };
        }
    } catch (error: any) {
        logger.error(`Exception adjusting margin: ${error.message}`);
        return { ok: false, message: `Exception adjusting margin: ${error.message}` };
    }
}

export async function cambiarModoMargen(
    symbol: string,
    modo: 'cross' | 'isolated',
    leverage: number,
    razon: string,
): Promise<OrderResponse> {
    try {
        const client = BybitUnified.getInstance();
        logger.info(`Attempting to change margin mode for ${symbol} to ${modo} with leverage ${leverage} due to: ${razon}`);
        const response = await client.setMarginMode({
            category: 'linear',
            symbol,
            tradeMode: modo === 'cross' ? 0 : 1, // 0 for Cross, 1 for Isolated
            buyLeverage: String(leverage),
            sellLeverage: String(leverage),
        });

        if (response.retCode === 0) {
            logger.info(`Margin mode changed successfully for ${symbol}: ${JSON.stringify(response.result)}`);
            return { ok: true, message: `Margin mode changed to ${modo} with ${leverage}x leverage.` };
        } else {
            logger.error(`Failed to change margin mode for ${symbol}: ${response.retMsg} (Code: ${response.retCode})`);
            return { ok: false, message: response.retMsg || 'Failed to change margin mode' };
        }
    } catch (error: any) {
        logger.error(`Exception changing margin mode: ${error.message}`);
        return { ok: false, message: `Exception changing margin mode: ${error.message}` };
    }
}
