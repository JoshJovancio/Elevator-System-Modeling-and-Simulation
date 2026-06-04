const FLOOR_COUNT = 11;
const LIFT_COUNT = 4;
const FLOOR_2_INDEX = 1;
const BLUE_FLOORS = [0, 2, 3, 4, 5, 6];
const RED_FLOORS = [0, 4, 7, 8, 9, 10];
const HUB_FLOOR = 4;

class Passenger {
    constructor(origin, finalDestination, createdAt, strategy, transferCount = 0, originalOrigin = null) {
        this.origin = origin;
        this.finalDestination = finalDestination;
        this.createdAt = createdAt;
        this.queueEnteredAt = createdAt;
        this.boardedAt = null;
        this.transferCount = transferCount;
        
        // FIX: Structural fallback handles newly spawned passengers (undefined) safely
        this.originalOrigin = (originalOrigin !== null && originalOrigin !== undefined) ? originalOrigin : origin;
        
        this.immediateDestination = routeImmediateDestination(origin, finalDestination, strategy);
        this.assignedElevatorId = null;
    }

    direction() {
        if (this.immediateDestination > this.origin) return 1;
        if (this.immediateDestination < this.origin) return -1;
        return 0;
    }
}

class FloorQueue {
    constructor(floorIdx) {
        this.floorIdx = floorIdx;
        this.waiting = [];
    }

    add(passenger) {
        this.waiting.push(passenger);
    }

    count(direction = null) {
        if (direction === null) return this.waiting.length;
        return this.waiting.filter((passenger) => passenger.direction() === direction).length;
    }

    countForElevator(elevatorId) {
        return this.waiting.filter((passenger) => passenger.assignedElevatorId === elevatorId).length;
    }

    destinationSummary(limit = 4) {
        const grouped = new Map();
        for (const passenger of this.waiting) {
            const floor = passenger.finalDestination + 1;
            grouped.set(floor, (grouped.get(floor) || 0) + 1);
        }

        return [...grouped.entries()]
            .sort((a, b) => b[1] - a[1] || a[0] - b[0])
            .slice(0, limit)
            .map(([floor, count]) => `F${floor}:${count}`);
    }

    takeForElevator(elevator, capacityLeft, strategy) {
        const boarded = [];
        const remaining = [];

        // Determine matching operational vectors
        const targetDirection = elevator.direction;

        for (const passenger of this.waiting) {
            const hasCapacity = capacityLeft > boarded.length;
            const isAssigned = passenger.assignedElevatorId === elevator.id;
            const validRoute = elevator.canServe(this.floorIdx, strategy) && elevator.canServe(passenger.immediateDestination, strategy);
            
            // Vector Match Constraint: Do not board passengers moving down into cars moving up (and vice versa)
            const directionMatch = elevator.cabin.length === 0 || targetDirection === 0 || passenger.direction() === targetDirection;

            if (hasCapacity && isAssigned && validRoute && directionMatch) {
                boarded.push(passenger);
            } else {
                remaining.push(passenger);
            }
        }

        this.waiting = remaining;
        return boarded;
    }
}

class Elevator {
    constructor(id, zone, startFloor, config) {
        this.id = id;
        this.zone = zone;
        this.currentFloor = startFloor;
        this.targetFloor = startFloor;
        this.direction = 0;
        this.state = "IDLE";
        this.cabin = [];
        this.capacityMin = config.capacityMin;
        this.capacityMax = config.capacityMax;
        this.capacity = randomCapacity(this.capacityMin, this.capacityMax);
        this.doorRemaining = 0;
        this.busySeconds = 0;
        this.travelSecondsPerFloor = config.travelTimePerFloor;
        this.doorSeconds = config.doorTime;
        this.boardingSeconds = config.boardingTimePerPassenger;
    }

    canServe(floorIdx, strategy) {
        if (floorIdx === FLOOR_2_INDEX && runtimeConfig.serveFloor2) return true;
        if (strategy === "All floors") return true;
        if (strategy === "Dynamic zoning") return dynamicServiceFloors(this.id).includes(floorIdx);
        if (this.zone === "BLUE") return BLUE_FLOORS.includes(floorIdx);
        return RED_FLOORS.includes(floorIdx);
    }

    loadRatio() {
        return this.cabin.length / this.capacity;
    }

    integerFloor() {
        return Math.round(this.currentFloor);
    }

    setTarget(floorIdx) {
        this.targetFloor = floorIdx;
        this.direction = Math.sign(this.targetFloor - this.currentFloor);
        this.state = this.direction === 0 ? "LOADING" : "MOVING";
    }

    hasDropAt(floorIdx) {
        return this.cabin.some((passenger) => passenger.immediateDestination === floorIdx);
    }

    shouldStopAt(floorIdx, floorQueues, strategy) {
        if (!this.canServe(floorIdx, strategy)) return false;
        if (this.hasDropAt(floorIdx)) return true;
        if (this.cabin.length >= this.capacity) return false;

        return floorQueues[floorIdx].waiting.some((passenger) => {
            return (
                passenger.assignedElevatorId === this.id &&
                this.canServe(passenger.immediateDestination, strategy) &&
                (this.direction === 0 || passenger.direction() === this.direction)
            );
        });
    }

    step(deltaSeconds, floorQueues, strategy) {
        if (this.state === "IDLE") return "IDLE";

        this.busySeconds += deltaSeconds;

        if (this.state === "LOADING") {
            this.doorRemaining -= deltaSeconds;
            if (this.doorRemaining <= 0) return "READY";
            return "LOADING";
        }

        const stepFloors = deltaSeconds / this.travelSecondsPerFloor;
        const distance = this.targetFloor - this.currentFloor;
        const nextDistance = Math.abs(distance) <= stepFloors ? 0 : Math.abs(distance) - stepFloors;
        this.currentFloor = distance === 0 ? this.currentFloor : this.targetFloor - Math.sign(distance) * nextDistance;

        const crossedFloor = this.integerFloor();
        const closeToFloor = Math.abs(this.currentFloor - crossedFloor) < 0.03;
        
        if (closeToFloor && this.shouldStopAt(crossedFloor, floorQueues, strategy)) {
            this.currentFloor = crossedFloor;
            this.targetFloor = crossedFloor;
            this.state = "LOADING";
            this.doorRemaining = this.doorSeconds;
            return "ARRIVED";
        }

        if (this.currentFloor === this.targetFloor) {
            this.state = "LOADING";
            this.doorRemaining = this.doorSeconds;
            return "ARRIVED";
        }

        return "MOVING";
    }
}

function randomCapacity(minCapacity, maxCapacity) {
    const min = Math.floor(minCapacity);
    const max = Math.floor(maxCapacity);
    return min + Math.floor(Math.random() * (max - min + 1));
}